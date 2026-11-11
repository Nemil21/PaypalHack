/**
 * HF-038b buyer rounds full, on real Postgres with the `FakePayPal` stub behind the real REST
 * client: the nudge consumer raises once under a covering mandate or asks the shopper (M07);
 * duplicate deliveries raise once; M11 caps; public-price cap; D12 cap under 10 parallel raises;
 * the 5-raise warning once; 20 SIM round agents over 2 rounds. Needs TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run --maxWorkers=2 packages/core/src/rounds-buyer.test.ts
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_HOLDS_WARNING, type Nudge } from '@holdfast/shared';
import { auditHook } from './audit.js';
import { raiseBid, raiseBidResponse, type RaisedBidBody } from './bid-raise.js';
import { getBidDetail, listMyBids } from './bid-views.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidDeps } from './bids.js';
import type { Db } from './db.js';
import { loadBook } from './listings/book.js';
import { liveHoldCents } from './mandates.js';
import { LISTING_EVENTS_CHANNEL } from './money/emit.js';
import type { BidRow } from './money/rows.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { FakePayPal } from './paypal/fake.js';
import { orderRequestId } from './paypal/ids.js';
import type { PayPalClient } from './paypal/types.js';
import {
  createNudgeConsumer,
  handleNudge,
  NUDGE_HANDLED_ACTION,
  PENDING_HOLDS_WARNED_ACTION,
  unhandledNudges,
  type NudgeHandled,
} from './rounds-buyer.js';
import { nextRound, startRounds, type RoundsActor } from './rounds/rounds.js';
import { roundsTiming } from './rounds/timing.js';

describe.skipIf(!TEST_DATABASE_URL)('HF-038b auto-raise runner (stub)', () => {
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
    fake.jitterMs = 0;
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

  async function vaultedShopper(opts: { simulated?: boolean } = {}): Promise<string> {
    const s = await fx.shopper();
    const r = await client.createAuthOrder({
      requestId: orderRequestId(randomUUID()),
      amountCents: 100,
      paymentSource: { kind: 'test_card', card: SANDBOX_TEST_CARD, vault: true },
    });
    if (r.kind !== 'held' || !r.vault?.id) throw new Error('no vault');
    await db.pool.query(
      `UPDATE shoppers SET paypal_vault_id = $2, is_simulated = $3 WHERE id = $1`,
      [s.id, r.vault.id, !!opts.simulated],
    );
    return s.id;
  }

  async function held(
    listingId: string,
    shopperId: string,
    amountCents: number,
    opts: { mandateId?: string; releaseIfCheaper?: boolean; source?: 'SIM' | 'OFFER_PAGE' } = {},
  ): Promise<BidRow> {
    const r = await placeBid(deps(), {
      shopperId,
      listingId,
      amountCents,
      paymentMethod: 'VAULT',
      source: opts.source ?? 'OFFER_PAGE',
      mandateId: opts.mandateId ?? null,
      releaseIfCheaper: opts.releaseIfCheaper ?? false,
      idempotencyKey: randomUUID(),
    });
    if (!r.ok || r.bid.status !== 'HELD') throw new Error(`no hold: ${JSON.stringify(r)}`);
    return r.bid;
  }

  const brandOf = async (listingId: string): Promise<string> =>
    (await db.pool.query(`SELECT brand_id FROM listings WHERE id = $1`, [listingId])).rows[0]
      .brand_id;
  const owner = (brandId: string): RoundsActor => ({
    type: 'BRAND_USER',
    id: `owner-of-${brandId}`,
    role: 'OWNER',
  });
  const bidRow = async (id: string): Promise<BidRow> =>
    (await db.pool.query(`SELECT * FROM bids WHERE id = $1`, [id])).rows[0] as BidRow;
  const successorOf = async (id: string): Promise<BidRow | null> =>
    ((await db.pool.query(`SELECT * FROM bids WHERE replaces_bid_id = $1`, [id])).rows[0] as
      BidRow | undefined) ?? null;
  const handledRows = async (nudgeId: string) =>
    (
      await db.pool.query(
        `SELECT actor_type, entity_id, data FROM audit_events
          WHERE action = $1 AND data->>'nudgeId' = $2`,
        [NUDGE_HANDLED_ACTION, nudgeId],
      )
    ).rows as Array<{ actor_type: string; entity_id: string; data: Record<string, unknown> }>;
  const orderCreates = () => fake.calls.filter((c) => c.op === 'order_create').length;

  /** A nudge the runner would send, for books driven round by round in the test. */
  async function fakeNudge(bid: BidRow, cutoffCents: number): Promise<Nudge> {
    const l = (
      await db.pool.query(`SELECT current_round, target_quantity FROM listings WHERE id = $1`, [
        bid.listing_id,
      ])
    ).rows[0] as { current_round: number; target_quantity: number };
    return {
      id: randomUUID(),
      listingId: bid.listing_id,
      bidId: bid.id,
      shopperId: bid.shopper_id,
      round: l.current_round,
      cutoffCents,
      yourBidCents: bid.amount_cents,
      targetQuantity: l.target_quantity,
      roundEndsAt: null,
      suggestedCents: cutoffCents + 100,
      text: 'test nudge',
      sentAt: new Date().toISOString(),
    };
  }

  /** HF-038a's book: $240 and $229 win Q=2 (cutoff $229); the $219 shopper is nudged. */
  async function roundsBook(low: { mandate?: { max: number; cap?: number }; rich?: boolean } = {}) {
    const l = await fx.listing();
    const brandId = await brandOf(l.id);
    const [a, b, c] = [await vaultedShopper(), await vaultedShopper(), await vaultedShopper()];
    const mandate = low.mandate
      ? await fx.mandate(c, {
          maxPriceCents: low.mandate.max,
          capCents: low.mandate.cap ?? low.mandate.max,
        })
      : null;
    const top = await held(l.id, a, 24_000);
    const mid = await held(l.id, b, 22_900);
    const lowBid = await held(l.id, c, 21_900, {
      mandateId: mandate?.id,
      releaseIfCheaper: low.rich,
    });
    return { l, brandId, top, mid, low: lowBid, mandateId: mandate?.id ?? null };
  }

  async function startWith(
    listingId: string,
    brandId: string,
    onNudge?: (n: Nudge) => void,
    q = 2,
  ) {
    const res = await startRounds(
      { db, onNudge },
      { listingId, brandId, actor: owner(brandId), targetQuantity: q },
    );
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    return res;
  }

  describe('decision', () => {
    it('a covering mandate: the agent raises once to max(cutoff + min, current + min)', async () => {
      const { l, brandId, low } = await roundsBook({ mandate: { max: 30_000 } });
      const handled: NudgeHandled[] = [];
      const consumer = createNudgeConsumer(deps(), { onHandled: (h) => handled.push(h) });
      const before = orderCreates();
      await startWith(l.id, brandId, consumer.onNudge);
      await consumer.drain();

      expect(handled).toHaveLength(1);
      expect(handled[0]).toMatchObject({ bidId: low.id, outcome: 'RAISED', targetCents: 23_129 });
      const next = (await successorOf(low.id))!;
      expect(next).toMatchObject({
        status: 'HELD',
        amount_cents: 23_129,
        raise_count: 1,
        payment_method: 'VAULT',
        mandate_id: low.mandate_id,
      });
      expect(next.idempotency_key).toBe(`raise:${handled[0]!.nudgeId}`);
      expect((await bidRow(low.id)).status).toBe('VOIDED');
      expect(orderCreates() - before).toBe(1);
      // Agent-initiated, merchant-initiated vaulted hold; audited as the buyer agent.
      const req = (
        await db.pool.query(
          `SELECT actor_type, data FROM audit_events WHERE entity_id = $1 AND action = 'BID_RAISE_REQUESTED'`,
          [next.id],
        )
      ).rows[0];
      expect(req).toMatchObject({ actor_type: 'BUYER_AGENT', data: { agentInitiated: true } });
      expect(await handledRows(handled[0]!.nudgeId)).toHaveLength(1);
    });

    it('no mandate: the shopper is asked via M07; nothing is held', async () => {
      const { l, brandId, low } = await roundsBook();
      const consumer = createNudgeConsumer(deps());
      const before = orderCreates();
      await startWith(l.id, brandId, consumer.onNudge);
      await consumer.drain();

      expect(orderCreates()).toBe(before);
      expect(await successorOf(low.id)).toBeNull();
      const mine = (await listMyBids(db.pool, low.shopper_id)).bids.find(
        (b) => b.bidId === low.id,
      )!;
      expect(mine.nudge).toMatchObject({
        suggestedCents: 23_129,
        agent: { outcome: 'ASKED', reason: 'NO_MANDATE', message: null },
      });
    });

    it('a raise never exceeds the mandate max: above it the shopper is asked', async () => {
      const { l, brandId, low } = await roundsBook({ mandate: { max: 23_000 } });
      const consumer = createNudgeConsumer(deps());
      const before = orderCreates();
      await startWith(l.id, brandId, consumer.onNudge);
      await consumer.drain();

      expect(orderCreates()).toBe(before);
      expect(await successorOf(low.id)).toBeNull();
      expect((await bidRow(low.id)).status).toBe('HELD');
      const mine = (await listMyBids(db.pool, low.shopper_id)).bids.find(
        (b) => b.bidId === low.id,
      )!;
      expect(mine.nudge?.agent).toEqual({
        outcome: 'ASKED',
        reason: 'ABOVE_MANDATE_MAX',
        message: "$231.29 is above your agent's max of $230, so it's asking you.",
      });
    });

    it('a mandate bid without a vault is asked (wallet / no saved method)', async () => {
      const { l, brandId, low } = await roundsBook({ mandate: { max: 30_000 } });
      await db.pool.query(`UPDATE shoppers SET paypal_vault_id = NULL WHERE id = $1`, [
        low.shopper_id,
      ]);
      const consumer = createNudgeConsumer(deps());
      await startWith(l.id, brandId, consumer.onNudge);
      await consumer.drain();
      expect(await successorOf(low.id)).toBeNull();
      const [row] = await handledRows(
        (await db.pool.query(`SELECT id FROM nudges WHERE bid_id = $1`, [low.id])).rows[0].id,
      );
      expect(row!.data).toMatchObject({ outcome: 'ASKED', reason: 'NO_VAULT' });
    });

    it('release_if_cheaper on: never above the best public price; the shopper is asked', async () => {
      const { l, brandId, low } = await roundsBook({ mandate: { max: 30_000 }, rich: true });
      await db.pool.query(
        `UPDATE products SET best_public_price_cents = 23_000
           WHERE id = (SELECT product_id FROM listings WHERE id = $1)`,
        [l.id],
      );
      const consumer = createNudgeConsumer(deps());
      const before = orderCreates();
      await startWith(l.id, brandId, consumer.onNudge);
      await consumer.drain();

      expect(orderCreates()).toBe(before);
      expect(await successorOf(low.id)).toBeNull();
      const mine = (await listMyBids(db.pool, low.shopper_id)).bids.find(
        (b) => b.bidId === low.id,
      )!;
      expect(mine.nudge?.agent).toMatchObject({ outcome: 'ASKED', reason: 'ABOVE_PUBLIC_PRICE' });
    });

    it('skips a bid that already ranks in or is no longer HELD', async () => {
      const { l, brandId, low, top } = await roundsBook({ mandate: { max: 30_000 } });
      const res = await startWith(l.id, brandId);
      const nudge = res.nudges[0]!;
      // The top shopper leaves: $219 now ranks in at Q=2.
      await db.pool.query(`UPDATE bids SET status = 'VOIDED' WHERE id = $1`, [top.id]);
      expect(await handleNudge(deps(), nudge)).toMatchObject({
        outcome: 'SKIPPED',
        reason: 'RANKS_IN',
      });
      const other = await fakeNudge(low, 22_900);
      await db.pool.query(`UPDATE bids SET status = 'VOIDED' WHERE id = $1`, [low.id]);
      expect(await handleNudge(deps(), other)).toMatchObject({
        outcome: 'SKIPPED',
        reason: 'BID_NOT_HELD',
      });
      expect(await successorOf(low.id)).toBeNull();
    });
  });

  describe('races (stub)', () => {
    it('the same nudge delivered twice (and to two instances) produces one raise', async () => {
      const { l, brandId, low } = await roundsBook({ mandate: { max: 30_000 } });
      const res = await startWith(l.id, brandId);
      const nudge = res.nudges.find((n) => n.bidId === low.id)!;
      fake.latencyMs = 20;
      fake.jitterMs = 20;
      const before = orderCreates();
      const a = createNudgeConsumer(deps());
      const b = createNudgeConsumer(deps());
      a.onNudge(nudge);
      a.onNudge(nudge); // same process: queued once
      b.onNudge(nudge);
      const direct = await Promise.all([handleNudge(deps(), nudge), handleNudge(deps(), nudge)]);
      await Promise.all([a.drain(), b.drain()]);

      const raises = await db.pool.query(`SELECT * FROM bids WHERE replaces_bid_id = $1`, [low.id]);
      expect(raises.rows).toHaveLength(1);
      expect(raises.rows[0]).toMatchObject({
        status: 'HELD',
        idempotency_key: `raise:${nudge.id}`,
      });
      expect(orderCreates() - before).toBe(1);
      // Whichever delivery won recorded the outcome once; the others replayed or were queued away.
      expect(direct.every((h) => h.outcome !== 'ASKED')).toBe(true);
      const rows = await handledRows(nudge.id);
      const raisedRows = rows.filter((r) => r.data.outcome === 'RAISED');
      expect(raisedRows).toHaveLength(1);
      expect(raisedRows[0]!.data).toMatchObject({ newBidId: raises.rows[0].id });
      expect(rows.length).toBeLessThanOrEqual(2);
      const live = await db.pool.query(
        `SELECT count(*)::int AS n FROM bids WHERE listing_id = $1 AND shopper_id = $2 AND status = 'HELD'`,
        [l.id, low.shopper_id],
      );
      expect(live.rows[0].n).toBe(1);
    });

    it('auto-raise at most once per round and 3 times per listing', async () => {
      // Q=1 behind a $400 leader: the agent's small raises stay below, so each round nudges again.
      const l = await fx.listing();
      const brandId = await brandOf(l.id);
      const [a, c] = [await vaultedShopper(), await vaultedShopper()];
      const m = await fx.mandate(c, { maxPriceCents: 100_000, capCents: 100_000 });
      await held(l.id, a, 40_000);
      let bid = await held(l.id, c, 21_900, { mandateId: m.id });
      await startWith(l.id, brandId, undefined, 1);

      const outcomes: string[] = [];
      for (let round = 1; round <= 4; round++) {
        if (round > 1) {
          await db.pool.query(`UPDATE listings SET current_round = $2 WHERE id = $1`, [
            l.id,
            round,
          ]);
        }
        const first = await handleNudge(deps(), await fakeNudge(bid, 20_000));
        outcomes.push(`${round}:${first.outcome}${first.reason ? `:${first.reason}` : ''}`);
        if (first.outcome === 'RAISED') bid = await bidRow(first.newBidId!);
        // A second nudge in the same round (e.g. another delivery path) is never a second raise.
        const second = await handleNudge(deps(), await fakeNudge(bid, 20_000));
        expect(second).toMatchObject({ outcome: 'ASKED', reason: 'AGENT_LIMIT' });
      }
      expect(outcomes).toEqual(['1:RAISED', '2:RAISED', '3:RAISED', '4:ASKED:AGENT_LIMIT']);
      expect(bid.raise_count).toBe(3);
    });

    it('10 parallel auto-raises across listings on one mandate keep live holds ≤ cap (D12)', async () => {
      const shopper = await vaultedShopper();
      const capCents = 95_000;
      const m = await fx.mandate(shopper, { maxPriceCents: 20_000, capCents });
      const bids: BidRow[] = [];
      for (let i = 0; i < 10; i++) {
        const l = await fx.listing();
        // $90 bids (below the $100 floor, so nobody wins and every bid stays nudged): $900 live.
        bids.push(await held(l.id, shopper, 9_000, { mandateId: m.id }));
        await db.pool.query(
          `UPDATE listings SET status = 'ROUNDS', window_closes_at = now(), rounds_started_at = now(),
                  rounds_end_at = now() + interval '1 hour', current_round = 1, target_quantity = 1
            WHERE id = $1`,
          [l.id],
        );
      }
      const nudges = await Promise.all(bids.map((b) => fakeNudge(b, 10_000)));
      fake.latencyMs = 15;
      fake.jitterMs = 25;
      const results = await Promise.all(nudges.map((n) => handleNudge(deps(), n)));

      const raised = results.filter((r) => r.outcome === 'RAISED');
      // Each raise adds $11 ($90 → $101): at most (950 − 900) / 11 → 4 fit. While a raise is in
      // flight its old HELD hold still counts next to the new one (D12 as HF-018 applies it), so
      // under contention fewer land; never more. Everyone else is asked, never over the cap.
      expect(raised.length).toBeGreaterThanOrEqual(1);
      expect(raised.length).toBeLessThanOrEqual(4);
      expect(results.filter((r) => r.outcome === 'ASKED').map((r) => r.reason)).toEqual(
        Array(10 - raised.length).fill('MANDATE_CAP'),
      );
      const live = await liveHoldCents(db.pool, m.id);
      expect(live).toBeLessThanOrEqual(capCents);
      expect(live).toBe(90_000 + raised.length * 1_100);
      // At PayPal too: the live (HELD) bids' authorizations sum to the same amount.
      const heldRows = (
        await db.pool.query(`SELECT * FROM bids WHERE mandate_id = $1 AND status = 'HELD'`, [m.id])
      ).rows as BidRow[];
      const atPayPal = heldRows
        .map((b) => fake.authorization(b.paypal_authorization_id!))
        .filter((a) => a?.status === 'CREATED')
        .reduce((s, a) => s + a!.amountCents, 0);
      expect(atPayPal).toBe(live);
    });
  });

  describe('5-raise warning', () => {
    it('appears exactly once per chain, on the raise that makes raise_count 5', async () => {
      const l = await fx.listing();
      const brandId = await brandOf(l.id);
      const [a, c] = [await vaultedShopper(), await vaultedShopper()];
      const m = await fx.mandate(c, { maxPriceCents: 100_000, capCents: 100_000 });
      await held(l.id, a, 40_000);
      let bid = await held(l.id, c, 20_000, { mandateId: m.id });
      await startWith(l.id, brandId, undefined, 1);

      const warnings: Array<string | null> = [];
      // Four shopper raises (uncapped) …
      for (let i = 0; i < 4; i++) {
        const r = await raiseBid(deps(), {
          bidId: bid.id,
          amountCents: bid.amount_cents + 500,
          shopperId: c,
          idempotencyKey: randomUUID(),
        });
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        warnings.push((raiseBidResponse(r).body as RaisedBidBody).warnPendingHolds);
        bid = r.bid;
      }
      // … then the agent's raise makes it 5: the warning is written once, even if replayed.
      const nudge = await fakeNudge(bid, 20_000);
      const h = await handleNudge(deps(), nudge);
      expect(h).toMatchObject({ outcome: 'RAISED', warnedPendingHolds: true });
      const replay = await handleNudge(deps(), nudge);
      expect(replay.warnedPendingHolds).toBeFalsy();
      bid = await bidRow(h.newBidId!);
      expect(bid.raise_count).toBe(5);
      // A 6th (shopper) raise carries no warning.
      const sixth = await raiseBid(deps(), {
        bidId: bid.id,
        amountCents: bid.amount_cents + 500,
        shopperId: c,
        idempotencyKey: randomUUID(),
      });
      if (!sixth.ok) throw new Error(JSON.stringify(sixth.error));
      warnings.push((raiseBidResponse(sixth).body as RaisedBidBody).warnPendingHolds);
      expect(warnings).toEqual([null, null, null, null, null]);

      const detail = await getBidDetail(db.pool, c, sixth.bid.id);
      const warned = detail!.timeline.filter((e) => e.step === PENDING_HOLDS_WARNED_ACTION);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.bidId).toBe(bid.id);
      expect(PENDING_HOLDS_WARNING).toMatch(/several pending holds/);
    });

    it('a shopper raise that makes raise_count 5 carries the warning in its response', async () => {
      const l = await fx.listing();
      let bid = await held(l.id, await vaultedShopper(), 20_000);
      const seen: Array<string | null> = [];
      for (let i = 0; i < 6; i++) {
        const r = await raiseBid(deps(), {
          bidId: bid.id,
          amountCents: bid.amount_cents + 500,
          shopperId: bid.shopper_id,
          idempotencyKey: randomUUID(),
        });
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        seen.push((raiseBidResponse(r).body as RaisedBidBody).warnPendingHolds);
        bid = r.bid;
      }
      expect(seen).toEqual([null, null, null, null, PENDING_HOLDS_WARNING, null]);
    });
  });

  describe('SIM round agents', () => {
    it('20 SIM agents + 1 real bidder over 2 scaled rounds: SIM raises land in the feed with SIM labels', async () => {
      const l = await fx.listing(); // quantity 10, floor $100
      const brandId = await brandOf(l.id);
      const notices: Array<{ type: string; ids: Record<string, string> }> = [];
      const listen = new pg.Client({ connectionString: t.url });
      await listen.connect();
      await listen.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
      listen.on('notification', (msg) => {
        const n = JSON.parse(msg.payload ?? '{}');
        if (n.listingId === l.id) notices.push(n);
      });

      try {
        // 20 vaulted SIM shoppers, $150 … $245 in $5 steps; every other one has a mandate max of
        // $400 (can raise), the rest a max equal to their bid (must be asked).
        const sims: Array<{ shopperId: string; bid: BidRow; canRaise: boolean }> = [];
        for (let i = 0; i < 20; i++) {
          const shopperId = await vaultedShopper({ simulated: true });
          const amount = 15_000 + i * 500;
          const canRaise = i % 2 === 0;
          const m = await fx.mandate(shopperId, {
            maxPriceCents: canRaise ? 40_000 : amount,
            capCents: canRaise ? 40_000 : amount,
          });
          sims.push({
            shopperId,
            bid: await held(l.id, shopperId, amount, { mandateId: m.id, source: 'SIM' }),
            canRaise,
          });
        }
        const realShopper = await vaultedShopper();
        const real = await held(l.id, realShopper, 15_200);

        const handled: NudgeHandled[] = [];
        const consumer = createNudgeConsumer(deps(), {
          concurrency: 5,
          onHandled: (h) => handled.push(h),
        });
        // A scaled round (ROUNDS_TIME_SCALE, demo): 90 s rounds; "Next round" advances it here.
        const roundsDeps = { db, onNudge: consumer.onNudge, timing: roundsTiming(0.05) };
        const r1 = await startRounds(roundsDeps, {
          listingId: l.id,
          brandId,
          actor: owner(brandId),
          targetQuantity: 10,
        });
        if (!r1.ok) throw new Error(JSON.stringify(r1.error));
        // The 10 lowest SIM bids and the real bidder are below the cutoff.
        expect(r1.nudges).toHaveLength(11);
        await consumer.drain();
        const round1 = handled.splice(0);
        expect(round1).toHaveLength(11);
        const raised1 = round1.filter((h) => h.outcome === 'RAISED');
        expect(raised1).toHaveLength(5); // the even-indexed half of the 10 nudged SIM agents
        expect(round1.find((h) => h.bidId === real.id)).toMatchObject({
          outcome: 'ASKED',
          reason: 'NO_MANDATE',
        });

        const r2 = await nextRound(roundsDeps, {
          listingId: l.id,
          brandId,
          actor: owner(brandId),
        });
        if (!r2.ok) throw new Error(JSON.stringify(r2.error));
        expect(r2.nudges.length).toBeGreaterThan(0);
        await consumer.drain();
        const round2 = handled.splice(0);
        const raised2 = round2.filter((h) => h.outcome === 'RAISED');
        expect(raised2.length).toBeGreaterThan(0);

        const raisedIds = [...raised1, ...raised2].map((h) => h.newBidId!);
        // Every raise is a SIM agent's, audited with the SIM actor, never two HELD per shopper.
        const req = await db.pool.query(
          `SELECT DISTINCT actor_type FROM audit_events
            WHERE action = 'BID_RAISE_REQUESTED' AND entity_id = ANY($1::uuid[])`,
          [raisedIds],
        );
        expect(req.rows).toEqual([{ actor_type: 'SIM' }]);
        const perShopper = await db.pool.query(
          `SELECT shopper_id, count(*)::int AS n FROM bids
            WHERE listing_id = $1 AND status = 'HELD' GROUP BY shopper_id HAVING count(*) > 1`,
          [l.id],
        );
        expect(perShopper.rows).toEqual([]);
        // Never above a mandate max: the capped half never raised.
        const capped = new Set(sims.filter((s) => !s.canRaise).map((s) => s.bid.id));
        expect([...raised1, ...raised2].some((h) => capped.has(h.bidId))).toBe(false);

        // The console feed (HF-037b): one bid.raised per raise, and the book labels them SIM.
        await new Promise((r) => setTimeout(r, 100));
        const raisedNotices = notices
          .filter((n) => n.type === 'bid.raised')
          .map((n) => n.ids.bidId);
        expect(new Set(raisedNotices)).toEqual(new Set(raisedIds));
        const book = await loadBook(db, brandId, l.id);
        const inBook = book.bids.filter((b) => raisedIds.includes(b.id));
        expect(inBook.length).toBeGreaterThan(0);
        expect(inBook.every((b) => b.isSimulated)).toBe(true);

        // Nothing was left unhandled.
        expect((await unhandledNudges(db.pool)).filter((n) => n.listingId === l.id)).toEqual([]);
      } finally {
        await listen.end();
      }
    });
  });
});
