/**
 * HF-038a buyer rounds basic, on real Postgres with the `FakePayPal` stub behind the real REST
 * client: a fixture round nudges a shopper → the bid page's `GET /bids/mine` poll shows the nudge
 * → the shopper raises in one tap (HF-018 swap) → the next poll shows the new hold and no nudge.
 * Also: `belowCutoff` is null outside ROUNDS and floor-blind; raises after `rounds_end_at` are
 * refused `WINDOW_CLOSED` with the frozen-book copy. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/rounds/buyer-rounds.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUNDS_ENDED_COPY, roundsRaisedMessage } from '@holdfast/shared';
import { auditHook } from '../audit.js';
import { raiseBid, raiseBidResponse } from '../bid-raise.js';
import { listMyBids, type MyBid } from '../bid-views.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidDeps } from '../bids.js';
import type { Db } from '../db.js';
import type { BidRow } from '../money/rows.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import { startRounds, stopRounds, type RoundsActor } from './rounds.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-038a buyer rounds: nudge → poll → raise (stub)', () => {
  let t: TestDatabase;
  let db: Db;
  let fx: Fixtures;
  let fake: FakePayPal;
  let client: PayPalClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    fx = new Fixtures(db);
    fake = new FakePayPal();
    client = fake.client({ timeoutMs: 10_000, holdRetries: 1 });
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    fake.latencyMs = 0;
    fake.clearFaults();
  });

  const deps = (): PlaceBidDeps => ({
    db,
    paypal: client,
    voidBackoffMs: [0, 0, 0],
    audit: auditHook,
    allowTestCard: true,
    appBaseUrl: 'https://holdfast.test',
  });

  async function vaultedShopper(): Promise<string> {
    const s = await fx.shopper();
    const r = await client.createAuthOrder({
      requestId: orderRequestId(randomUUID()),
      amountCents: 100,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
    });
    if (r.kind !== 'held' || !r.vault?.id) throw new Error('no vault');
    await db.pool.query(`UPDATE shoppers SET paypal_vault_id = $2 WHERE id = $1`, [
      s.id,
      r.vault.id,
    ]);
    return s.id;
  }

  async function held(listingId: string, shopperId: string, amountCents: number) {
    const r = await placeBid(deps(), {
      shopperId,
      listingId,
      amountCents,
      paymentMethod: 'VAULT',
      source: 'OFFER_PAGE',
      idempotencyKey: randomUUID(),
    });
    if (!r.ok || r.bid.status !== 'HELD') throw new Error(`no hold: ${JSON.stringify(r)}`);
    return r.bid;
  }

  /** One tap on the bid page: a fresh Idempotency-Key per user action. */
  const tapRaise = (bid: Pick<BidRow, 'id' | 'shopper_id'>, amountCents: number) =>
    raiseBid(deps(), {
      bidId: bid.id,
      amountCents,
      shopperId: bid.shopper_id,
      idempotencyKey: randomUUID(),
    });

  /** The W14/W15 5 s poll. */
  const poll = async (shopperId: string, bidId: string): Promise<MyBid> => {
    const { bids } = await listMyBids(db.pool, shopperId);
    const bid = bids.find((b) => b.bidId === bidId);
    if (!bid) throw new Error(`bid ${bidId} not in my bids`);
    return bid;
  };

  async function brandOf(listingId: string): Promise<string> {
    return (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [listingId])).rows[0]
      .brand_id;
  }
  const owner = (brandId: string): RoundsActor => ({
    type: 'BRAND_USER',
    id: `owner-of-${brandId}`,
    role: 'OWNER',
  });

  /** Book: $240 and $229 win Q=2 (cutoff $229); the $219 shopper is nudged. */
  async function roundsBook() {
    const l = await fx.listing();
    const brandId = await brandOf(l.id);
    const [a, b, c] = [await vaultedShopper(), await vaultedShopper(), await vaultedShopper()];
    const top = await held(l.id, a, 24_000);
    const mid = await held(l.id, b, 22_900);
    const low = await held(l.id, c, 21_900);
    return { l, brandId, top, mid, low };
  }

  async function start(listingId: string, brandId: string) {
    const res = await startRounds(
      { db },
      { listingId, brandId, actor: owner(brandId), targetQuantity: 2 },
    );
    expect(res.ok).toBe(true);
    return res;
  }

  it('outside ROUNDS: belowCutoff, cutoffCents and nudge are null; the bid is raisable', async () => {
    const { low } = await roundsBook();
    const mine = await poll(low.shopper_id, low.id);
    expect(mine).toMatchObject({ belowCutoff: null, cutoffCents: null, nudge: null });
    expect(mine.listing).toMatchObject({ status: 'OPEN', raisable: true });
  });

  it('nudged shopper sees the nudge on the next poll and raises in one tap (D1 swap)', async () => {
    const { l, brandId, top, low } = await roundsBook();
    await start(l.id, brandId);

    // Poll: the nudge with numbers equal to clear() output; the winner sees nothing.
    const nudged = await poll(low.shopper_id, low.id);
    expect(nudged.listing).toMatchObject({ status: 'ROUNDS', raisable: true });
    expect(nudged).toMatchObject({ belowCutoff: true, cutoffCents: 22_900 });
    // max(cutoff + minRaise(cutoff), current + minRaise(current)) = max(229 + 2.29, 219 + 2.19)
    expect(nudged.nudge).toMatchObject({
      round: 1,
      cutoffCents: 22_900,
      suggestedCents: 23_129,
      text: "You're out at $219. The cutoff is $229. Raise to $231.29?",
    });
    expect(await poll(top.shopper_id, top.id)).toMatchObject({ belowCutoff: false, nudge: null });

    // One tap: raise to the suggested amount.
    const r = await tapRaise(low, nudged.nudge!.suggestedCents);
    expect(r.ok, JSON.stringify(r.ok ? null : r.error)).toBe(true);
    if (!r.ok) return;
    expect(r.bid).toMatchObject({ status: 'HELD', amount_cents: 23_129, replaces_bid_id: low.id });
    expect(r.oldBid).toMatchObject({ id: low.id, status: 'VOIDED', void_reason: 'REPLACED' });
    expect(fake.authorization(r.bid.paypal_authorization_id!)?.status).toBe('CREATED');
    expect(fake.authorization(low.paypal_authorization_id!)?.status).toBe('VOIDED');
    expect(roundsRaisedMessage(r.oldBid.amount_cents, r.bid.amount_cents, true)).toBe(
      'New $231.29 hold placed · $219 hold released',
    );
    const held = await db.pool.query(
      `SELECT id FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD'`,
      [l.id, low.shopper_id],
    );
    expect(held.rows).toEqual([{ id: r.bid.id }]);

    // Next poll: the new bid beats the cutoff, so no nudge; the old one is released.
    const after = await poll(low.shopper_id, r.bid.id);
    expect(after).toMatchObject({
      status: 'HELD',
      amountCents: 23_129,
      belowCutoff: false,
      cutoffCents: 22_900,
      nudge: null,
    });
    expect(await poll(low.shopper_id, low.id)).toMatchObject({
      status: 'VOIDED',
      belowCutoff: null,
      nudge: null,
    });
  });

  it('a raise that is still below the cutoff keeps the nudge, recomputed for the new bid', async () => {
    const { l, brandId, low } = await roundsBook();
    await start(l.id, brandId);
    const r = await tapRaise(low, 22_200);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mine = await poll(low.shopper_id, r.bid.id);
    expect(mine).toMatchObject({ belowCutoff: true, cutoffCents: 22_900 });
    expect(mine.nudge).toMatchObject({
      cutoffCents: 22_900,
      suggestedCents: 23_129,
      text: "You're out at $222. The cutoff is $229. Raise to $231.29?",
    });
  });

  it('declined raise: the old bid still stands and the nudge stays', async () => {
    const { l, brandId, low } = await roundsBook();
    await start(l.id, brandId);
    fake.failNext('order_create', { kind: 'decline' });
    const r = await tapRaise(low, 23_129);
    expect(r.ok).toBe(false);
    const res = raiseBidResponse(r);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: { code: 'HOLD_FAILED', message: "Couldn't raise. Your $219 bid still stands." },
    });
    expect(await poll(low.shopper_id, low.id)).toMatchObject({
      status: 'HELD',
      belowCutoff: true,
      nudge: { suggestedCents: 23_129 },
    });
  });

  it('the floor never reaches the payload: changing it leaves my bids byte-identical', async () => {
    const { l, brandId, low } = await roundsBook();
    await start(l.id, brandId);
    const before = JSON.stringify(await listMyBids(db.pool, low.shopper_id));
    await db.pool.query(`UPDATE listings SET floor_cents = 23456 WHERE id = $1`, [l.id]);
    const after = JSON.stringify(await listMyBids(db.pool, low.shopper_id));
    expect(after).toBe(before);
    expect(after).not.toContain('23456');
    expect(after).not.toMatch(/floor/i);
  });

  it('frozen book: after rounds_end_at the bid is not raisable and a raise is WINDOW_CLOSED', async () => {
    const { l, brandId, low } = await roundsBook();
    await start(l.id, brandId);
    const stopped = await stopRounds({ db }, { listingId: l.id, brandId, actor: owner(brandId) });
    expect(stopped.ok).toBe(true);

    const mine = await poll(low.shopper_id, low.id);
    expect(mine.listing).toMatchObject({ status: 'ROUNDS', raisable: false });

    const r = await tapRaise(low, 23_129);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'WINDOW_CLOSED', roundsEnded: true });
    const res = raiseBidResponse(r);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: {
        code: 'WINDOW_CLOSED',
        roundsEnded: true,
        message: `${ROUNDS_ENDED_COPY} Your $219 bid still stands.`,
      },
    });
    expect((await fx.bid(low.id)).status).toBe('HELD');
  });
});
