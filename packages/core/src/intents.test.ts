/**
 * HF-052 intents and the move rule: the pure rule, plus integration and race tests on real
 * Postgres with the `FakePayPal` stub behind the real REST client. The DB part needs
 * TEST_DATABASE_URL.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/intents.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clear } from '@holdfast/shared';
import { auditHook } from './audit.js';
import { moveBid, moveBidResponse, type MoveBidResult } from './bid-move.js';
import { placeBid, SANDBOX_TEST_CARD, type PlaceBidDeps } from './bids.js';
import { loadClearInput } from './clearInput.js';
import type { Db } from './db.js';
import {
  activateIntent,
  createIntent,
  runOpenIntents,
  decideIntent,
  intentBidCents,
  listIntents,
  pickBook,
  requiredBidCents,
  runIntent,
  type BookCandidate,
  type IntentBid,
  type IntentState,
} from './intents.js';
import { CRON_JOB_IDS, holdfastCronJobs } from './crons/jobs.js';
import { clearListing } from './listings/clear-listing.js';
import { landHold } from './money/land-hold.js';
import type { BidRow } from './money/rows.js';
import {
  Fixtures,
  TEST_DATABASE_URL,
  createTestDatabase,
  type TestDatabase,
} from './money/test-harness.js';
import { voidBid } from './money/void.js';
import { FakePayPal } from './paypal/fake.js';
import { orderRequestId } from './paypal/ids.js';
import type { PayPalClient } from './paypal/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;
const T0 = new Date('2026-11-12T12:00:00Z');

function book(id: string, extra: Partial<BookCandidate> = {}): BookCandidate {
  return {
    listingId: id,
    title: `Product ${id}`,
    brandName: 'Aurel Audio',
    quantity: 2,
    closesAt: new Date(T0.getTime() + 24 * HOUR),
    otherAmountsCents: [],
    bestPublicPriceCents: null,
    ...extra,
  };
}

function bid(id: string, listingId: string, extra: Partial<IntentBid> = {}): IntentBid {
  return {
    id,
    listingId,
    status: 'HELD',
    voidReason: null,
    amountCents: 20_000,
    placedAt: T0,
    title: `Product ${listingId}`,
    ...extra,
  };
}

const state = (extra: Partial<IntentState>): IntentState => ({
  intentStatus: 'OPEN',
  mandateStatus: 'ACTIVE',
  maxCents: 25_000,
  bids: [],
  books: [],
  ...extra,
});

describe('HF-052 move rule (unit)', () => {
  it('required bid: the minimum while seats are open, else 1¢ above the quantity-th other bid', () => {
    expect(requiredBidCents([], 2)).toBe(100);
    expect(requiredBidCents([30_000], 2)).toBe(100);
    expect(requiredBidCents([30_000, 21_000, 25_000], 2)).toBe(25_001);
  });

  it('pick: lowest required bid relative to the max, then earliest close', () => {
    const a = book('a', { otherAmountsCents: [24_000, 23_000] }); // needs $230.01
    const b = book('b', { otherAmountsCents: [21_000, 20_000] }); // needs $210.01
    const c = book('c', {
      otherAmountsCents: [21_000, 20_000],
      closesAt: new Date(T0.getTime() + 2 * HOUR),
    });
    expect(pickBook([a, b], 25_000)!.book.listingId).toBe('b');
    expect(pickBook([a, b, c], 25_000)!.book.listingId).toBe('c'); // same required, closes first
    // Nothing fits under the max.
    expect(pickBook([a], 22_000)).toBeNull();
    expect(pickBook([a, b], 25_000, new Set(['b']))!.book.listingId).toBe('a');
  });

  it('bid amount: at least the required bid and the suggestion, never above the max', () => {
    expect(intentBidCents(100, 27_900, 25_000)).toBe(22_900); // 18% under the public low
    expect(intentBidCents(24_001, 27_900, 25_000)).toBe(24_001);
    expect(intentBidCents(100, 40_000, 25_000)).toBe(25_000);
    expect(intentBidCents(100, null, 25_000)).toBe(25_000);
  });

  it('no bid yet: place in the best book; none open → watch', () => {
    const d = decideIntent(state({ books: [book('a'), book('b', { closesAt: T0 })] }));
    expect(d).toMatchObject({ kind: 'place', listingId: 'b' });
    expect(decideIntent(state({ books: [] }))).toMatchObject({ kind: 'watch' });
  });

  it('closes lost: once the LOST bid is released, place in the other book and say why', () => {
    const lost = bid('x', 'a', { status: 'VOIDED', voidReason: 'LOST', amountCents: 21_000 });
    const d = decideIntent(state({ bids: [lost], books: [book('b')] }));
    expect(d).toMatchObject({ kind: 'place', listingId: 'b' });
    expect(d.why).toMatch(/\$210 bid in the Product a book lost/);
    // Still LOST (a promotion may turn it into a win): never a second bid.
    expect(
      decideIntent(state({ bids: [{ ...lost, status: 'LOST' }], books: [book('b')] })),
    ).toMatchObject({ kind: 'stay' });
  });

  it('held: a winning bid stays; a losing bid moves only to a book likelier to clear', () => {
    const held = bid('x', 'a', { amountCents: 22_000 });
    const winning = book('a', { otherAmountsCents: [21_000, 20_000] });
    expect(decideIntent(state({ bids: [held], books: [winning, book('b')] }))).toMatchObject({
      kind: 'stay',
    });
    const losing = book('a', { otherAmountsCents: [24_000, 23_000] });
    const d = decideIntent(state({ bids: [held], books: [losing, book('b')] }));
    expect(d).toMatchObject({ kind: 'move', bidId: 'x', toListingId: 'b' });
    expect(d.why).toMatch(/below the \$230\.01 needed/);
    // The other book is no easier: stay.
    const harder = book('b', { otherAmountsCents: [24_500, 24_000] });
    expect(decideIntent(state({ bids: [held], books: [losing, harder] }))).toMatchObject({
      kind: 'stay',
    });
  });

  it('paused mandate, in-flight holds, a win, or a cancelled bid stop the rule', () => {
    expect(decideIntent(state({ mandateStatus: 'PAUSED', books: [book('a')] }))).toMatchObject({
      kind: 'stay',
    });
    expect(
      decideIntent(
        state({ bids: [bid('x', 'a', { status: 'PENDING_APPROVAL' })], books: [book('b')] }),
      ),
    ).toMatchObject({ kind: 'stay' });
    expect(
      decideIntent(state({ bids: [bid('x', 'a', { status: 'WON' })], books: [book('b')] })),
    ).toMatchObject({ kind: 'done' });
    expect(
      decideIntent(
        state({
          bids: [bid('x', 'a', { status: 'VOIDED', voidReason: 'CANCELLED' })],
          books: [book('b')],
        }),
      ),
    ).toMatchObject({ kind: 'done' });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('HF-052 intents (stub)', () => {
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

  function deps(): PlaceBidDeps {
    return { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook, allowTestCard: true };
  }

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

  /** An OPEN listing of its own product, with a title and quantity. */
  async function listing(title: string, cols: { quantity?: number; closesInHours?: number } = {}) {
    const l = await fx.listing({ closesInHours: cols.closesInHours ?? 24 });
    const row = (
      await db.pool.query(
        `UPDATE listings SET quantity = $2 WHERE id = $1 RETURNING id, product_id, brand_id`,
        [l.id, cols.quantity ?? 1],
      )
    ).rows[0] as { id: string; product_id: string; brand_id: string };
    await db.pool.query(`UPDATE products SET title = $2 WHERE id = $1`, [row.product_id, title]);
    return row;
  }

  async function heldBid(listingId: string, shopperId: string, amountCents: number) {
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

  async function activeIntent(shopperId: string, productIds: string[], maxPriceCents = 25_000) {
    const c = await createIntent(db.pool, {
      shopperId,
      text: 'A7-class headphones',
      productIds,
      maxPriceCents,
    });
    if (!c.ok) throw new Error(c.message);
    return c;
  }

  const intentHeld = async (intentId: string) =>
    (
      await db.pool.query(
        `SELECT id, listing_id FROM bids WHERE intent_id = $1 AND status = 'HELD'`,
        [intentId],
      )
    ).rows as { id: string; listing_id: string }[];

  async function clearNow(listingId: string, brandId: string, quantity: number) {
    for (let attempt = 1; ; attempt++) {
      const input = await loadClearInput(db.pool, listingId);
      const result = clear(input!.bids, quantity, input!.floorCents);
      const out = await clearListing(
        { db, paypal: client, voidBackoffMs: [0, 0, 0], audit: auditHook },
        {
          listingId,
          brandId,
          quantity,
          expectedGrossCents: result.grossCents,
          actor: { type: 'BRAND_USER', id: 'u1' },
        },
      );
      if (out.ok || attempt === 3) return out;
      await sleep(50);
    }
  }

  /** What settlement does to a loser (HF-029): release the LOST hold. */
  async function releaseLosers(listingId: string) {
    const lost = (
      await db.pool.query(`SELECT id FROM bids WHERE listing_id = $1 AND status = 'LOST'`, [
        listingId,
      ])
    ).rows as { id: string }[];
    for (const { id } of lost) {
      await voidBid(deps(), id, 'LOST', { type: 'WORKFLOW' }, { from: ['LOST'] });
    }
  }

  it('create_intent: mandate PAUSED until confirmed; confirm activates it and places in the best book', async () => {
    const s = await vaultedShopper();
    const a = await listing('Aurel One', { closesInHours: 30 });
    const b = await listing('Nova X', { closesInHours: 6 });
    const c = await activeIntent(s, [a.product_id, b.product_id]);
    expect(c.mandate).toMatchObject({
      status: 'PAUSED',
      max_price_cents: 25_000,
      auto_roll: false,
    });
    expect(c.intent).toMatchObject({ status: 'OPEN', mandate_id: c.mandate.id });

    // Paused: the job does nothing.
    expect((await runIntent(deps(), c.intent.id))?.action).toBe('none');
    expect(await intentHeld(c.intent.id)).toEqual([]);

    const act = await activateIntent(deps(), s, c.intent.id);
    expect(act.ok).toBe(true);
    const held = await intentHeld(c.intent.id);
    expect(held).toEqual([{ id: expect.any(String), listing_id: b.id }]); // closes first
    const m = (await db.pool.query(`SELECT status FROM mandates WHERE id = $1`, [c.mandate.id]))
      .rows[0];
    expect(m.status).toBe('ACTIVE');
    const row = await fx.bid(held[0]!.id);
    expect(row).toMatchObject({
      intent_id: c.intent.id,
      mandate_id: c.mandate.id,
      source: 'BUYER_AGENT',
    });
  });

  it('unknown product ids are refused; no open book → the intent watches, then places when one opens', async () => {
    const s = await vaultedShopper();
    expect(
      await createIntent(db.pool, {
        shopperId: s,
        text: 'x',
        productIds: [randomUUID()],
        maxPriceCents: 20_000,
      }),
    ).toMatchObject({ ok: false, field: 'productIds' });

    const l = await listing('Aurel One');
    await db.pool.query(`UPDATE listings SET status = 'DRAFT' WHERE id = $1`, [l.id]);
    const c = await activeIntent(s, [l.product_id]);
    const act = await activateIntent(deps(), s, c.intent.id);
    expect(act.ok && act.run?.decision.kind).toBe('watch');

    await db.pool.query(`UPDATE listings SET status = 'OPEN' WHERE id = $1`, [l.id]);
    expect((await runIntent(deps(), c.intent.id))?.action).toBe('placed');
    expect(await intentHeld(c.intent.id)).toHaveLength(1);
  });

  it('an intent across 2 products moves the bid when one book closes lost', async () => {
    const s = await vaultedShopper();
    const rival = await vaultedShopper();
    const a = await listing('Aurel One', { closesInHours: 2, quantity: 1 });
    const b = await listing('Nova X', { closesInHours: 30, quantity: 1 });
    const c = await activeIntent(s, [a.product_id, b.product_id]);
    await activateIntent(deps(), s, c.intent.id);
    const [first] = await intentHeld(c.intent.id);
    expect(first!.listing_id).toBe(a.id);

    // A rival outbids it and the brand clears A: the intent's bid is LOST.
    const firstRow = await fx.bid(first!.id);
    await heldBid(a.id, rival, (firstRow.amount_cents as number) + 1_000);
    expect((await clearNow(a.id, a.brand_id, 1)).ok).toBe(true);
    expect((await fx.bid(first!.id)).status).toBe('LOST');

    // While LOST (a promotion could still make it win), the rule waits.
    expect((await runIntent(deps(), c.intent.id))?.decision.kind).toBe('stay');

    await releaseLosers(a.id);
    const run = await runIntent(deps(), c.intent.id);
    expect(run?.action).toBe('placed');
    const now = await intentHeld(c.intent.id);
    expect(now).toEqual([{ id: expect.any(String), listing_id: b.id }]);

    // "Why did you move my bid?"
    const [view] = (await listIntents(db.pool, s)).filter((i) => i.intentId === c.intent.id);
    expect(view!.liveBid).toMatchObject({ listingId: b.id, status: 'HELD' });
    const last = view!.history.at(-1)!;
    expect(last).toMatchObject({ kind: 'PLACED', toListingId: b.id });
    expect(last.why).toMatch(/lost when the brand cleared it, so I moved to the Nova X book/);
  });

  it('a better book: the losing bid moves (D1 swap): old VOIDED REPLACED at PayPal, new HELD', async () => {
    const s = await vaultedShopper();
    const r1 = await vaultedShopper();
    const r2 = await vaultedShopper();
    const a = await listing('Aurel One', { quantity: 2 });
    const c = await activeIntent(s, [a.product_id]);
    await activateIntent(deps(), s, c.intent.id);
    const [old] = await intentHeld(c.intent.id);
    const oldRow = (await fx.bid(old!.id)) as unknown as BidRow;

    // The intent bid its $250 max (no public price); two rivals outbid it.
    await heldBid(a.id, r1, 25_500);
    await heldBid(a.id, r2, 26_000);
    // A second product's book opens and the intent may bid there.
    const b = await listing('Nova X', { quantity: 2 });
    await db.pool.query(`UPDATE intents SET product_ids = product_ids || $2::uuid WHERE id = $1`, [
      c.intent.id,
      b.product_id,
    ]);
    await db.pool.query(
      `UPDATE mandates SET allowed_product_ids = allowed_product_ids || $2::uuid WHERE id = $1`,
      [c.mandate.id, b.product_id],
    );

    const run = await runIntent(deps(), c.intent.id);
    expect(run?.action).toBe('moved');
    const moved = run!.action === 'moved' ? run.result : null;
    expect(moved?.ok).toBe(true);
    if (!moved?.ok) return;
    expect(moved.bid).toMatchObject({
      status: 'HELD',
      listing_id: b.id,
      replaces_bid_id: old!.id,
      intent_id: c.intent.id,
      mandate_id: c.mandate.id,
    });
    expect(moved.oldBid).toMatchObject({ status: 'VOIDED', void_reason: 'REPLACED' });
    expect(fake.authorization(oldRow.paypal_authorization_id!)?.status).toBe('VOIDED');
    expect(await intentHeld(c.intent.id)).toEqual([{ id: moved.bid.id, listing_id: b.id }]);
    expect(moveBidResponse(moved).status).toBe(201);

    const [view] = (await listIntents(db.pool, s)).filter((i) => i.intentId === c.intent.id);
    expect(view!.history.at(-1)).toMatchObject({ kind: 'MOVED', reason: 'BETTER_BOOK' });
    expect(view!.history.at(-1)!.why).toMatch(/below the \$255\.01 needed to win there/);
  });

  it('a move above the mandate max is refused before any hold; the cap excludes the moved bid (D12)', async () => {
    const s = await vaultedShopper();
    const a = await listing('Aurel One');
    const b = await listing('Nova X');
    const c = await activeIntent(s, [a.product_id, b.product_id], 25_000);
    await activateIntent(deps(), s, c.intent.id);
    const [old] = await intentHeld(c.intent.id);
    const target = old!.listing_id === a.id ? b : a;
    const mv = (amountCents: number) =>
      moveBid(deps(), {
        bidId: old!.id,
        toListingId: target.id,
        amountCents,
        shopperId: s,
        idempotencyKey: randomUUID(),
        reason: 'SHOPPER',
      });
    const over = await mv(25_100);
    expect(over).toMatchObject({ ok: false, error: { code: 'ABOVE_MANDATE_MAX' } });
    // Cap = max ($250) and one live hold of ~$250 already: the move fits only because the old
    // bid is excluded.
    const ok = await mv(25_000);
    expect(ok.ok).toBe(true);
  });

  it('the intent-move-rule job runs every minute and acts only on ACTIVE intents of vaulted shoppers', async () => {
    const jobs = holdfastCronJobs({ ...deps(), runIntents: () => runOpenIntents(deps()) });
    const job = jobs.find((j) => j.id === CRON_JOB_IDS.intentMoveRule)!;
    expect(job.intervalMs).toBe(60_000);

    const s = await vaultedShopper();
    const noVault = (await fx.shopper()).id;
    const l = await listing('Aurel One');
    const on = await activeIntent(s, [l.product_id]);
    const paused = await activeIntent(s, [l.product_id]);
    const unvaulted = await activeIntent(noVault, [l.product_id]);
    await db.pool.query(`UPDATE mandates SET status = 'ACTIVE' WHERE id = ANY($1::uuid[])`, [
      [on.mandate.id, unvaulted.mandate.id],
    ]);
    await job.run();
    expect(await intentHeld(on.intent.id)).toHaveLength(1);
    expect(await intentHeld(paused.intent.id)).toHaveLength(0);
    expect(await intentHeld(unvaulted.intent.id)).toHaveLength(0);
    // Idempotent: a second run leaves the winning bid alone.
    await job.run();
    expect(await intentHeld(on.intent.id)).toHaveLength(1);
  });

  describe('races (stub)', () => {
    it('two concurrent moves of one bid: one wins, the other holds nothing live; never two HELD', async () => {
      for (let i = 0; i < 5; i++) {
        const s = await vaultedShopper();
        const a = await listing('Aurel One');
        const b = await listing('Nova X');
        const c2 = await listing('Sono 3');
        const c = await activeIntent(s, [a.product_id, b.product_id, c2.product_id]);
        await activateIntent(deps(), s, c.intent.id);
        // A cap of one hold would already refuse the second move (D12, 422); widen it so the
        // replace race itself (UNIQUE(replaces_bid_id), D3) is what decides.
        await db.pool.query(`UPDATE mandates SET total_hold_cap_cents = 100000 WHERE id = $1`, [
          c.mandate.id,
        ]);
        const [old] = await intentHeld(c.intent.id);
        const others = [a, b, c2].filter((l) => l.id !== old!.listing_id);
        fake.latencyMs = 150;
        fake.jitterMs = 100;
        const results: MoveBidResult[] = await Promise.all(
          others.map((l) =>
            moveBid(deps(), {
              bidId: old!.id,
              toListingId: l.id,
              amountCents: 21_000,
              shopperId: s,
              idempotencyKey: randomUUID(),
              reason: 'SHOPPER',
            }),
          ),
        );
        fake.latencyMs = 0;
        fake.jitterMs = 0;
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        const winner = results.find((r) => r.ok)!;
        const loser = results.find((r) => !r.ok)!;
        expect(moveBidResponse(loser).status).toBe(409);
        expect(await intentHeld(c.intent.id)).toEqual([
          { id: winner.bid!.id, listing_id: winner.bid!.listing_id },
        ]);
        // No authorization outside the winner is left CREATED for this shopper.
        const live = (
          await db.pool.query(
            `SELECT id, status, paypal_authorization_id FROM bids
              WHERE shopper_id = $1 AND paypal_authorization_id IS NOT NULL`,
            [s],
          )
        ).rows as { id: string; status: string; paypal_authorization_id: string }[];
        for (const r of live) {
          const auth = fake.authorization(r.paypal_authorization_id)?.status;
          expect(auth).toBe(r.id === winner.bid!.id ? 'CREATED' : 'VOIDED');
        }
      }
    }, 60_000);

    it('two holds landing for one intent at once (index backstop): one HELD, the other voided at PayPal', async () => {
      for (let i = 0; i < 5; i++) {
        const s = await vaultedShopper();
        const a = await listing('Aurel One');
        const b = await listing('Nova X');
        const intent = await fx.intent(s);
        const pa = await fx.pendingBid(a.id, s, { amountCents: 20_000, intentId: intent.id });
        const pb = await fx.pendingBid(b.id, s, { amountCents: 20_000, intentId: intent.id });
        const vault = (
          await db.pool.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [s])
        ).rows[0].paypal_vault_id as string;
        const holds = await Promise.all(
          [pa, pb].map((p) =>
            client.createAuthOrder({
              requestId: orderRequestId(p.id),
              amountCents: 20_000,
              paymentSource: { kind: 'card_vault', vaultId: vault, initiator: 'MERCHANT' },
            }),
          ),
        );
        const landed = await Promise.all(
          [pa, pb].map((p, j) => {
            const h = holds[j]!;
            if (h.kind !== 'held') throw new Error('no hold');
            return landHold(deps(), {
              bidId: p.id,
              authorizationId: h.authorizationId,
              authorizedAt: h.authorizedAt,
              authorizedAmountCents: h.amountCents,
              paypalOrderId: h.orderId,
            });
          }),
        );
        expect(landed.filter((r) => r.ok)).toHaveLength(1);
        const lost = landed.find((r) => !r.ok)!;
        expect(lost).toMatchObject({ ok: false, reason: 'ALREADY_BID', voided: true });
        if (!lost.ok) {
          expect(lost.bid.status).toBe('VOIDED');
          expect(fake.authorization(lost.bid.paypal_authorization_id!)?.status).toBe('VOIDED');
        }
        expect(await intentHeld(intent.id)).toHaveLength(1);
      }
    }, 60_000);

    it('a move racing Clear on the source listing never leaves both bids HELD', async () => {
      const schedule = [
        { latencyMs: 500, clearAfterMs: 100 }, // Clear lands during the PayPal call
        { latencyMs: 0, clearAfterMs: 400 }, // the swap lands first
        { latencyMs: 150, clearAfterMs: 150 },
        { latencyMs: 100, clearAfterMs: 120 },
        { latencyMs: 200, clearAfterMs: 180 },
      ];
      const seen = new Set<string>();
      for (const { latencyMs, clearAfterMs } of schedule) {
        const s = await vaultedShopper();
        const rival = await vaultedShopper();
        const a = await listing('Aurel One', { quantity: 2, closesInHours: 2 });
        const b = await listing('Nova X', { quantity: 2, closesInHours: 30 });
        const c = await activeIntent(s, [a.product_id, b.product_id]);
        await activateIntent(deps(), s, c.intent.id);
        const [old] = await intentHeld(c.intent.id);
        expect(old!.listing_id).toBe(a.id);
        await heldBid(a.id, rival, 21_000);

        fake.latencyMs = latencyMs;
        fake.jitterMs = 30;
        const moving = moveBid(deps(), {
          bidId: old!.id,
          toListingId: b.id,
          amountCents: 22_000,
          shopperId: s,
          idempotencyKey: randomUUID(),
          reason: 'SHOPPER',
        });
        await sleep(clearAfterMs);
        const cleared = await clearNow(a.id, a.brand_id, 2);
        fake.latencyMs = 0;
        fake.jitterMs = 0;
        const r = await moving;
        expect(cleared.ok).toBe(true);

        // Never two live bids for the intent; Clear on A never saw a bid the move took away.
        const held = await intentHeld(c.intent.id);
        expect(held.length).toBeLessThanOrEqual(1);
        const inClear = (
          await db.pool.query(
            `SELECT id FROM bids WHERE intent_id = $1 AND status IN ('WON', 'LOST')`,
            [c.intent.id],
          )
        ).rows as { id: string }[];
        expect(held.length + inClear.length).toBe(1);

        seen.add(r.ok ? 'move-first' : 'clear-first');
        if (r.ok) {
          expect(held).toEqual([{ id: r.bid.id, listing_id: b.id }]);
          expect((await fx.bid(old!.id)).status).toBe('VOIDED');
        } else {
          expect(inClear).toEqual([{ id: old!.id }]);
          if (r.bid?.paypal_authorization_id) {
            expect(fake.authorization(r.bid.paypal_authorization_id)?.status).toBe('VOIDED');
          }
        }
      }
      expect([...seen].sort()).toEqual(['clear-first', 'move-first']);
    }, 60_000);
  });
});
