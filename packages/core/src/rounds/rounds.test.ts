/**
 * HF-036a integration tests: live rounds on real Postgres with FakePayPal (HF-004), including the
 * concurrent "Next round" race from old HF-047. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/rounds
 */
import { clear, nudgeText, type ListingEvent, type Nudge } from '@holdfast/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadClearInput } from '../clearInput.js';
import type { Db, Queryable } from '../db.js';
import { landHold } from '../money/land-hold.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import { listShopperNudges } from './nudges.js';
import {
  nextRound,
  setRoundsTarget,
  startRounds,
  stopRounds,
  type RoundsActor,
  type RoundsDeps,
} from './rounds.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

interface Listing {
  id: string;
  brandId: string;
}

describe.skipIf(!TEST_DATABASE_URL)('HF-036a live rounds (Postgres + FakePayPal)', () => {
  let t: TestDatabase;
  let db: Db;
  let paypal: PayPalClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    paypal = new FakePayPal().client();
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  const owner = (brandId: string): RoundsActor => ({
    type: 'BRAND_USER',
    id: `owner-of-${brandId}`,
    role: 'OWNER',
  });

  async function listing(
    cols: {
      quantity?: number;
      floorCents?: number;
      status?: string;
      /** Hours from now; negative = in the past. */
      opensIn?: number;
      closesIn?: number;
    } = {},
  ): Promise<Listing> {
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    const row = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, $3, $4, $5, now() + $6::float8 * interval '1 hour',
               now() + $7::float8 * interval '1 hour')
       RETURNING id`,
      [
        brand.id,
        product.id,
        cols.status ?? 'OPEN',
        cols.quantity ?? 10,
        cols.floorCents ?? 10_000,
        cols.opensIn ?? -1,
        cols.closesIn ?? 24,
      ],
    );
    return { id: row.id, brandId: brand.id };
  }

  async function shopper(): Promise<string> {
    return (
      await one<{ id: string }>(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`)
    ).id;
  }

  /** A FakePayPal hold for a fresh bid id. */
  async function paypalHold(bidId: string, amountCents: number) {
    const r = await paypal.createAuthOrder({
      requestId: orderRequestId(bidId),
      amountCents,
      paymentSource: {
        kind: 'test_card',
        card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'R' },
        vault: false,
      },
    });
    if (r.kind !== 'held') throw new Error(`no hold: ${r.kind}`);
    return r;
  }

  /** A PENDING_APPROVAL bid landed through landHold (the real path to HELD). */
  async function place(
    l: Listing,
    amountCents: number,
    opts: { shopperId?: string; replacesBidId?: string } = {},
  ) {
    const shopperId = opts.shopperId ?? (await shopper());
    const bid = await one<{ id: string }>(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, replaces_bid_id, idempotency_key)
       VALUES ($1, $2, $3, $4, gen_random_uuid()::text) RETURNING id`,
      [l.id, shopperId, amountCents, opts.replacesBidId ?? null],
    );
    const hold = await paypalHold(bid.id, amountCents);
    const res = await landHold(
      { db, paypal, voidBackoffMs: [0, 0, 0] },
      {
        bidId: bid.id,
        authorizationId: hold.authorizationId,
        authorizedAt: hold.authorizedAt,
        authorizedAmountCents: amountCents,
        paypalOrderId: hold.orderId,
        replacesBidId: opts.replacesBidId ?? null,
        actor: { type: 'SHOPPER', id: shopperId },
      },
    );
    return { ...res, bidId: bid.id, shopperId };
  }

  /** A HELD bid placed while the window is open (fails the test otherwise). */
  async function held(l: Listing, amountCents: number, shopperId?: string) {
    const r = await place(l, amountCents, { shopperId });
    if (!r.ok) throw new Error(`hold refused: ${r.reason}`);
    return { id: r.bidId, shopperId: r.shopperId, amountCents };
  }

  async function listingRow(id: string) {
    return one<{
      status: string;
      current_round: number | null;
      target_quantity: number | null;
      rounds_started_at: Date | null;
      window_opens_at: Date;
      window_closes_at: Date;
      rounds_end_at: Date | null;
      clear_deadline_at: Date | null;
      now: Date;
    }>(`SELECT *, clock_timestamp() AS now FROM listings WHERE id = $1`, [id]);
  }

  async function nudgesOf(listingId: string, round?: number) {
    return q<{
      bid_id: string;
      shopper_id: string;
      round: number;
      cutoff_cents: number;
      your_bid_cents: number;
      target_cents: number;
      units_left: number;
      text: string;
    }>(
      `SELECT * FROM nudges WHERE listing_id = $1 AND ($2::int IS NULL OR round = $2)
        ORDER BY round, your_bid_cents DESC`,
      [listingId, round ?? null],
    );
  }

  function deps(extra: Partial<RoundsDeps> = {}): RoundsDeps {
    return { db, ...extra };
  }

  /** Expected nudges for the listing's current book, straight from clear(). */
  async function expectedNudges(listingId: string, targetQuantity: number) {
    const book = (await loadClearInput(db.pool as unknown as Queryable, listingId))!;
    const result = clear(book.bids, targetQuantity, book.floorCents);
    const winners = new Set(result.winners.map((b) => b.id));
    return {
      cutoff: result.cutoffCents,
      bidIds: book.bids.filter((b) => !winners.has(b.id)).map((b) => b.id),
    };
  }

  describe('start', () => {
    it('sets every D6/D7 deadline in one transaction while the window is still open', async () => {
      const l = await listing({ opensIn: -2, closesIn: 20 });
      await held(l, 30_000);
      await held(l, 20_000);
      const before = await listingRow(l.id);

      const res = await startRounds(deps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: owner(l.brandId),
        targetQuantity: 1,
      });
      expect(res.ok).toBe(true);
      const row = await listingRow(l.id);
      const started = row.rounds_started_at!.getTime();
      expect(row).toMatchObject({ status: 'ROUNDS', current_round: 1, target_quantity: 1 });
      // window_closes_at = least(window_closes_at, now)
      expect(row.window_closes_at.getTime()).toBe(started);
      // rounds_end_at = least(now + 6h, original close + 6h)
      expect(row.rounds_end_at!.getTime()).toBe(
        Math.min(started + 6 * HOUR, before.window_closes_at.getTime() + 6 * HOUR),
      );
      // clear_deadline_at = least(rounds_end_at + 6h, window_opens_at + 60h)
      expect(row.clear_deadline_at!.getTime()).toBe(
        Math.min(
          row.rounds_end_at!.getTime() + 6 * HOUR,
          row.window_opens_at.getTime() + 60 * HOUR,
        ),
      );
      expect(res.ok && res.state).toMatchObject({
        status: 'ROUNDS',
        round: 1,
        targetQuantity: 1,
        roundsEndAt: row.rounds_end_at!.toISOString(),
        windowClosesAt: row.window_closes_at.toISOString(),
        clearDeadlineAt: row.clear_deadline_at!.toISOString(),
        nudged: 1,
        endedReason: null,
      });
      const audits = await q<{ action: string }>(
        `SELECT action FROM audit_events WHERE listing_id = $1 AND entity = 'listing'`,
        [l.id],
      );
      expect(audits.map((a) => a.action)).toContain('ROUNDS_STARTED');
    });

    it('after the window closed: keeps window_closes_at and caps rounds at close + 6h', async () => {
      const l = await listing({ opensIn: -30, closesIn: 1 });
      await held(l, 30_000);
      await held(l, 20_000);
      await q(`UPDATE listings SET window_closes_at = now() - interval '2 hours' WHERE id = $1`, [
        l.id,
      ]);
      const before = await listingRow(l.id);
      const res = await startRounds(deps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: owner(l.brandId),
        targetQuantity: 1,
      });
      expect(res.ok).toBe(true);
      const row = await listingRow(l.id);
      expect(row.window_closes_at.getTime()).toBe(before.window_closes_at.getTime());
      expect(row.rounds_end_at!.getTime()).toBe(before.window_closes_at.getTime() + 6 * HOUR);
      expect(row.clear_deadline_at!.getTime()).toBe(
        Math.min(
          row.rounds_end_at!.getTime() + 6 * HOUR,
          row.window_opens_at.getTime() + 60 * HOUR,
        ),
      );
    });

    it('a second start → 409 ROUNDS_ALREADY_STARTED; concurrent starts: exactly one wins', async () => {
      const l = await listing();
      await held(l, 30_000);
      await held(l, 20_000);
      const input = {
        listingId: l.id,
        brandId: l.brandId,
        actor: owner(l.brandId),
        targetQuantity: 1,
      };
      const results = await Promise.all([1, 2, 3].map(() => startRounds(deps(), input)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((r) => !r.ok)) {
        expect(r).toMatchObject({
          ok: false,
          error: { code: 'STATE_CONFLICT', reason: 'ROUNDS_ALREADY_STARTED' },
        });
      }
      expect(await nudgesOf(l.id)).toHaveLength(1);
      expect(await startRounds(deps(), input)).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'ROUNDS_ALREADY_STARTED' },
      });
    });

    it.each(['DRAFT', 'CLEARING', 'CANCELLED', 'EXPIRED'])(
      'start on a %s listing → 409 NOT_OPEN',
      async (status) => {
        const l = await listing({ status });
        expect(
          await startRounds(deps(), {
            listingId: l.id,
            brandId: l.brandId,
            actor: owner(l.brandId),
            targetQuantity: 1,
          }),
        ).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', reason: 'NOT_OPEN' } });
      },
    );

    it('more than 6 h after the window closed → 409 ROUNDS_WINDOW_PASSED', async () => {
      const l = await listing({ opensIn: -40, closesIn: -7 });
      expect(
        await startRounds(deps(), {
          listingId: l.id,
          brandId: l.brandId,
          actor: owner(l.brandId),
          targetQuantity: 1,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'ROUNDS_WINDOW_PASSED' },
      });
    });

    it('Q above the listing quantity → VALIDATION_ERROR; another brand → NOT_FOUND', async () => {
      const l = await listing({ quantity: 3 });
      expect(
        await startRounds(deps(), {
          listingId: l.id,
          brandId: l.brandId,
          actor: owner(l.brandId),
          targetQuantity: 4,
        }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', maxQuantity: 3 } });
      const other = await listing();
      expect(
        await startRounds(deps(), {
          listingId: l.id,
          brandId: other.brandId,
          actor: owner(other.brandId),
          targetQuantity: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect((await listingRow(l.id)).status).toBe('OPEN');
    });

    it('nobody below the cutoff → rounds end at once (round.ended NONE_BELOW_CUTOFF)', async () => {
      const l = await listing();
      await held(l, 30_000);
      await held(l, 20_000);
      const events: ListingEvent[] = [];
      const res = await startRounds(
        deps({
          emit: async (_tx, _id, e) => {
            events.push(e);
          },
        }),
        { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId), targetQuantity: 5 },
      );
      expect(res).toMatchObject({
        ok: true,
        state: { nudged: 0, endedReason: 'NONE_BELOW_CUTOFF' },
      });
      const row = await listingRow(l.id);
      expect(row.rounds_end_at!.getTime()).toBeLessThanOrEqual(row.now.getTime());
      expect(events.map((e) => e.type)).toEqual(['listing.status', 'round.started', 'round.ended']);
      expect(events[2]).toMatchObject({ reason: 'NONE_BELOW_CUTOFF' });
    });
  });

  describe('bidding after start (D7)', () => {
    it('new bids → WINDOW_CLOSED; raises accepted until rounds_end_at, then refused', async () => {
      const l = await listing();
      const a = await held(l, 30_000);
      const b = await held(l, 20_000);
      await startRounds(deps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: owner(l.brandId),
        targetQuantity: 1,
      });

      const late = await place(l, 40_000);
      expect(late).toMatchObject({ ok: false, reason: 'WINDOW_CLOSED' });

      const raise = await place(l, 31_000, { shopperId: b.shopperId, replacesBidId: b.id });
      expect(raise.ok).toBe(true);

      const stopped = await stopRounds(deps(), {
        listingId: l.id,
        brandId: l.brandId,
        actor: owner(l.brandId),
      });
      expect(stopped).toMatchObject({ ok: true, state: { endedReason: 'BRAND_STOPPED' } });

      const frozen = await place(l, 32_000, { shopperId: a.shopperId, replacesBidId: a.id });
      expect(frozen).toMatchObject({ ok: false, reason: 'WINDOW_CLOSED' });
    });
  });

  describe('rounds flow: start → next × 2 → stop', () => {
    it('nudges exactly the bids not in winners, once per round, numbers equal clear()', async () => {
      const l = await listing({ quantity: 5, floorCents: 15_000 });
      // seq order = placement order: the 25_000 placed later loses the tie on time priority.
      const top = await held(l, 30_000);
      const tieWin = await held(l, 25_000);
      const tieLose = await held(l, 25_000);
      const reserve = await held(l, 20_000);
      const belowFloor = await held(l, 12_000);
      const received: Nudge[] = [];
      const d = deps({ onNudge: (n) => void received.push(n) });
      const base = { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) };

      const start = await startRounds(d, { ...base, targetQuantity: 2 });
      expect(start).toMatchObject({ ok: true, state: { round: 1, nudged: 3 } });
      const exp1 = await expectedNudges(l.id, 2);
      expect(exp1.cutoff).toBe(25_000);
      const r1 = await nudgesOf(l.id, 1);
      expect(r1.map((n) => n.bid_id).sort()).toEqual(exp1.bidIds.sort());
      expect(r1.map((n) => n.bid_id).sort()).toEqual(
        [tieLose.id, reserve.id, belowFloor.id].sort(),
      );
      expect(r1.map((n) => n.bid_id)).not.toContain(top.id);
      expect(r1.map((n) => n.bid_id)).not.toContain(tieWin.id);
      const tieNudge = r1.find((n) => n.bid_id === tieLose.id)!;
      expect(tieNudge).toMatchObject({
        cutoff_cents: 25_000,
        your_bid_cents: 25_000,
        target_cents: 25_250,
        units_left: 2,
        text: nudgeText({ yourBidCents: 25_000, cutoffCents: 25_000, suggestedCents: 25_250 }),
      });
      await sleep(10);
      expect(received).toHaveLength(3);

      // The reserve bid raises to the suggested amount; round 2 re-snapshots the new book.
      const r1Reserve = r1.find((n) => n.bid_id === reserve.id)!;
      const raised = await place(l, r1Reserve.target_cents, {
        shopperId: reserve.shopperId,
        replacesBidId: reserve.id,
      });
      expect(raised.ok).toBe(true);

      const next1 = await nextRound(d, base);
      expect(next1).toMatchObject({ ok: true, state: { round: 2 } });
      const exp2 = await expectedNudges(l.id, 2);
      expect(exp2.cutoff).toBe(25_250);
      const r2 = await nudgesOf(l.id, 2);
      expect(r2.map((n) => n.bid_id).sort()).toEqual(exp2.bidIds.sort());
      expect(r2.every((n) => n.cutoff_cents === 25_250)).toBe(true);
      expect(r2.map((n) => n.bid_id)).toContain(tieWin.id);

      // PATCH Q: the next round uses it.
      expect(await setRoundsTarget(d, { ...base, targetQuantity: 3 })).toMatchObject({
        ok: true,
        state: { targetQuantity: 3, round: 2 },
      });
      const next2 = await nextRound(d, { ...base, fromRound: 2 });
      expect(next2).toMatchObject({ ok: true, state: { round: 3, targetQuantity: 3 } });
      const exp3 = await expectedNudges(l.id, 3);
      const r3 = await nudgesOf(l.id, 3);
      expect(r3.map((n) => n.bid_id).sort()).toEqual(exp3.bidIds.sort());
      expect(r3.every((n) => n.cutoff_cents === exp3.cutoff && n.units_left === 3)).toBe(true);

      // One nudge per (listing, round, shopper), and the shopper view is the shared shape.
      const all = await nudgesOf(l.id);
      const keys = all.map((n) => `${n.round}:${n.shopper_id}`);
      expect(new Set(keys).size).toBe(keys.length);
      const mine = await listShopperNudges(db.pool, tieLose.shopperId, { listingId: l.id });
      expect(mine.map((n) => n.round)).toEqual([3, 2, 1]);

      const stop = await stopRounds(d, base);
      expect(stop).toMatchObject({ ok: true, state: { endedReason: 'BRAND_STOPPED' } });
      const row = await listingRow(l.id);
      expect(Math.abs(row.rounds_end_at!.getTime() - row.now.getTime())).toBeLessThan(5_000);

      // Frozen: next, stop and PATCH are refused.
      for (const r of [
        await nextRound(d, base),
        await stopRounds(d, base),
        await setRoundsTarget(d, { ...base, targetQuantity: 2 }),
      ]) {
        expect(r).toMatchObject({
          ok: false,
          error: { code: 'STATE_CONFLICT', reason: 'ROUNDS_ENDED' },
        });
      }

      const actions = await q<{ action: string; n: number }>(
        `SELECT action, count(*)::int AS n FROM audit_events WHERE listing_id = $1
          GROUP BY action ORDER BY action`,
        [l.id],
      );
      expect(Object.fromEntries(actions.map((a) => [a.action, a.n]))).toMatchObject({
        ROUNDS_STARTED: 1,
        ROUND_ADVANCED: 2,
        ROUNDS_TARGET_CHANGED: 1,
        ROUNDS_STOPPED: 1,
        NUDGE_SENT: all.length,
      });
    });

    it('next / stop / PATCH on a listing not in rounds → 409 NOT_IN_ROUNDS', async () => {
      const l = await listing();
      const base = { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) };
      for (const r of [
        await nextRound(deps(), base),
        await stopRounds(deps(), base),
        await setRoundsTarget(deps(), { ...base, targetQuantity: 1 }),
      ]) {
        expect(r).toMatchObject({
          ok: false,
          error: { code: 'STATE_CONFLICT', reason: 'NOT_IN_ROUNDS' },
        });
      }
    });

    it('a stale "Next round" (fromRound behind) → 409 ROUND_ADVANCED', async () => {
      const l = await listing();
      await held(l, 30_000);
      await held(l, 20_000);
      const base = { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) };
      await startRounds(deps(), { ...base, targetQuantity: 1 });
      await nextRound(deps(), { ...base, fromRound: 1 });
      expect(await nextRound(deps(), { ...base, fromRound: 1 })).toMatchObject({
        ok: false,
        error: { code: 'STATE_CONFLICT', reason: 'ROUND_ADVANCED', round: 2 },
      });
    });
  });

  describe('race (stub, from old HF-047)', () => {
    it('concurrent "Next round" calls advance current_round exactly once; one nudge per (listing, round, shopper)', async () => {
      const l = await listing({ quantity: 10 });
      for (const amount of [40_000, 35_000, 30_000, 25_000, 20_000, 15_000]) await held(l, amount);
      const base = { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) };
      await startRounds(deps(), { ...base, targetQuantity: 2 });

      // Hold the winner's transaction open so every other call queues on the listing row.
      const d = deps({ afterListingUpdate: () => sleep(50) });
      const results = await Promise.all(Array.from({ length: 8 }, () => nextRound(d, base)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((r) => !r.ok)) {
        expect(r).toMatchObject({
          ok: false,
          error: { code: 'STATE_CONFLICT', reason: 'ROUND_ADVANCED' },
        });
      }
      expect((await listingRow(l.id)).current_round).toBe(2);
      expect(await nudgesOf(l.id, 2)).toHaveLength(4);
      const counts = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM nudges WHERE listing_id = $1
          GROUP BY round, shopper_id HAVING count(*) > 1`,
        [l.id],
      );
      expect(counts).toEqual([]);
      const advanced = await q(
        `SELECT 1 FROM audit_events WHERE listing_id = $1 AND action = 'ROUND_ADVANCED'`,
        [l.id],
      );
      expect(advanced).toHaveLength(1);

      // Same race with the explicit round from the console.
      const again = await Promise.all(
        Array.from({ length: 5 }, () => nextRound(d, { ...base, fromRound: 2 })),
      );
      expect(again.filter((r) => r.ok)).toHaveLength(1);
      expect((await listingRow(l.id)).current_round).toBe(3);
      expect(await nudgesOf(l.id, 3)).toHaveLength(4);
    });

    it('"Next round" racing "Stop": stop wins or the round advances first; never a round after stop', async () => {
      const l = await listing();
      for (const amount of [30_000, 20_000, 15_000]) await held(l, amount);
      const base = { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) };
      await startRounds(deps(), { ...base, targetQuantity: 1 });
      const d = deps({ afterListingUpdate: () => sleep(30) });
      const [next, stop] = await Promise.all([nextRound(d, base), stopRounds(d, base)]);
      expect(stop.ok).toBe(true);
      const row = await listingRow(l.id);
      if (next.ok) expect(row.current_round).toBe(2);
      else {
        expect(next).toMatchObject({ error: { reason: 'ROUNDS_ENDED' } });
        expect(row.current_round).toBe(1);
      }
      const latest = await one<{ max: number }>(
        `SELECT max(round)::int AS max FROM nudges WHERE listing_id = $1`,
        [l.id],
      );
      expect(latest.max).toBe(row.current_round);
    });
  });

  describe('floor never leaks', () => {
    it('changing the floor changes nothing in nudges, SSE events, responses or my_bids', async () => {
      async function runWithFloor(floorCents: number) {
        const l = await listing({ quantity: 5, floorCents });
        for (const amount of [30_000, 25_000, 22_000, 21_000]) await held(l, amount);
        const events: ListingEvent[] = [];
        const d = deps({
          emit: async (_tx, _id, e) => {
            events.push(e);
          },
        });
        const base = { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) };
        const responses = [
          await startRounds(d, { ...base, targetQuantity: 2 }),
          await nextRound(d, base),
          await stopRounds(d, base),
        ];
        const shoppers = await q<{ shopper_id: string }>(
          `SELECT DISTINCT shopper_id FROM nudges WHERE listing_id = $1`,
          [l.id],
        );
        const views = (
          await Promise.all(
            shoppers.map((s) => listShopperNudges(db.pool, s.shopper_id, { listingId: l.id })),
          )
        ).flat();
        // Normalise ids and times so the two runs can be diffed.
        const norm = (v: unknown) =>
          JSON.parse(
            JSON.stringify(v)
              .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
              .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')
              .replace(/Shopper #\d+/g, 'Shopper #N'),
          );
        const sortKey = (x: { yourBidCents?: number; round?: number }) =>
          `${x.round}:${x.yourBidCents}`;
        return {
          raw: JSON.stringify({ events, responses, views }),
          events: norm(events),
          responses: norm(responses),
          views: norm(views.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))),
        };
      }

      const low = await runWithFloor(10_101);
      const high = await runWithFloor(20_202);
      expect(high.events).toEqual(low.events);
      expect(high.responses).toEqual(low.responses);
      expect(high.views).toEqual(low.views);
      expect(low.views.length).toBeGreaterThan(0);
      for (const [run, floor] of [
        [low, 10_101],
        [high, 20_202],
      ] as const) {
        expect(run.raw).not.toContain(String(floor));
        expect(run.raw).not.toContain(`$${floor / 100}`);
        expect(run.raw.toLowerCase()).not.toContain('floor');
      }
    });
  });

  describe('roles', () => {
    it('VIEWER, shoppers, buyer agents, MCP clients and the brand agent are FORBIDDEN', async () => {
      const l = await listing();
      await held(l, 30_000);
      await held(l, 20_000);
      const forbidden: RoundsActor[] = [
        { type: 'BRAND_USER', id: 'v', role: 'VIEWER' },
        { type: 'SHOPPER', id: 's' },
        { type: 'BUYER_AGENT', id: 'b' },
        { type: 'MCP_CLIENT', id: 'm' },
        { type: 'BRAND_AGENT', id: 'a', role: 'OWNER' },
      ];
      for (const actor of forbidden) {
        const base = { listingId: l.id, brandId: l.brandId, actor };
        for (const r of [
          await startRounds(deps(), { ...base, targetQuantity: 1 }),
          await nextRound(deps(), base),
          await stopRounds(deps(), base),
          await setRoundsTarget(deps(), { ...base, targetQuantity: 1 }),
        ]) {
          expect(r).toEqual({ ok: false, error: { code: 'FORBIDDEN' } });
        }
      }
      expect((await listingRow(l.id)).status).toBe('OPEN');
      expect(
        await startRounds(deps(), {
          listingId: l.id,
          brandId: l.brandId,
          actor: { type: 'BRAND_USER', id: 'm', role: 'MANAGER' },
          targetQuantity: 1,
        }),
      ).toMatchObject({ ok: true });
    });
  });

  describe('hold age (D6)', () => {
    it('stop: the oldest hold is ≤ 60 h old at clear_deadline_at', async () => {
      // Window opened 47 h ago and closes in 1 h; the oldest hold dates from the window opening.
      const l = await listing({ opensIn: -47, closesIn: 1 });
      const a = await held(l, 30_000);
      await held(l, 20_000);
      await q(
        `UPDATE bids SET authorized_at = (SELECT window_opens_at FROM listings WHERE id = $1)
          WHERE id = $2`,
        [l.id, a.id],
      );
      const base = { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) };
      await startRounds(deps(), { ...base, targetQuantity: 1 });
      const started = await listingRow(l.id);
      await stopRounds(deps(), base);
      const row = await listingRow(l.id);
      expect(row.clear_deadline_at!.getTime()).toBeLessThanOrEqual(
        started.clear_deadline_at!.getTime(),
      );
      expect(row.clear_deadline_at!.getTime()).toBeLessThanOrEqual(
        row.rounds_end_at!.getTime() + 6 * HOUR,
      );
      const age = await one<{ ok: boolean }>(
        `SELECT l.clear_deadline_at - min(b.authorized_at) <= interval '60 hours' AS ok
           FROM listings l JOIN bids b ON b.listing_id = l.id AND b.status = 'HELD'
          WHERE l.id = $1 GROUP BY l.clear_deadline_at`,
        [l.id],
      );
      expect(age.ok).toBe(true);
    });
  });
});
