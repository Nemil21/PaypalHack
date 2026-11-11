/**
 * HF-036b integration tests: the live rounds timer on real Postgres with FakePayPal (HF-004):
 * two tick loops on one DB, scripted raises in the soft-close window, every end rule,
 * `ROUNDS_TIME_SCALE` and Claude being unavailable. Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/rounds
 *
 * Time is scripted by moving `round_ends_at` / `rounds_end_at` in the DB rather than waiting.
 */
import { nudgeText, type ListingEvent, type Nudge } from '@holdfast/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type Queryable } from '../db.js';
import { landHold } from '../money/land-hold.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import type { NudgePhraser, PhrasingContext } from './phrasing.js';
import {
  startRounds,
  stopRounds,
  setRoundsTarget,
  type RoundsActor,
  type RoundsDeps,
} from './rounds.js';
import { roundsListingIds, startRoundsTicker, stepListing, tickRounds } from './tick.js';
import { roundsTiming, UNSCALED_TIMING } from './timing.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const CLAUDE_TEMPLATE =
  'Your {yourBid} bid sits under the {cutoff} cutoff for {targetQuantity} units. Raise to {suggested}?';

interface Listing {
  id: string;
  brandId: string;
}
interface Held {
  id: string;
  shopperId: string;
  amountCents: number;
}

describe.skipIf(!TEST_DATABASE_URL)('HF-036b rounds timer (Postgres + FakePayPal)', () => {
  let t: TestDatabase;
  let db: Db;
  /** A second "instance": its own pool on the same database. */
  let db2: Db;
  let pool2: pg.Pool;
  let paypal: PayPalClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    pool2 = new pg.Pool({ connectionString: t.url, max: 10 });
    pool2.on('error', () => {});
    db2 = createDb(pool2);
    paypal = new FakePayPal().client();
  }, 60_000);

  afterAll(async () => {
    await pool2?.end();
    await t?.close();
  }, 60_000);

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await q<T>(sql, params))[0]!;

  const owner = (brandId: string): RoundsActor => ({
    type: 'BRAND_USER',
    id: `owner-of-${brandId}`,
    role: 'OWNER',
  });

  async function listing(cols: { quantity?: number; floorCents?: number; closesIn?: number } = {}) {
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel Audio', 'payouts@aurel.example') RETURNING id`,
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    const row = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, 'OPEN', $3, $4, now() - interval '1 hour',
               now() + $5::float8 * interval '1 hour')
       RETURNING id`,
      [brand.id, product.id, cols.quantity ?? 10, cols.floorCents ?? 10_000, cols.closesIn ?? 24],
    );
    return { id: row.id, brandId: brand.id } as Listing;
  }

  async function shopper(): Promise<string> {
    return (
      await one<{ id: string }>(`INSERT INTO shoppers (display_name) VALUES ('Sam') RETURNING id`)
    ).id;
  }

  /** A bid landed through landHold (the real path to HELD; with `replaces` it is a raise). */
  async function land(l: Listing, amountCents: number, shopperId: string, replaces?: string) {
    const bid = await one<{ id: string }>(
      `INSERT INTO bids (listing_id, shopper_id, amount_cents, replaces_bid_id, idempotency_key)
       VALUES ($1, $2, $3, $4, gen_random_uuid()::text) RETURNING id`,
      [l.id, shopperId, amountCents, replaces ?? null],
    );
    const hold = await paypal.createAuthOrder({
      requestId: orderRequestId(bid.id),
      amountCents,
      paymentSource: {
        kind: 'test_card',
        card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'R' },
        vault: false,
      },
    });
    if (hold.kind !== 'held') throw new Error(`no hold: ${hold.kind}`);
    const res = await landHold(
      { db, paypal, voidBackoffMs: [0, 0, 0] },
      {
        bidId: bid.id,
        authorizationId: hold.authorizationId,
        authorizedAt: hold.authorizedAt,
        authorizedAmountCents: amountCents,
        paypalOrderId: hold.orderId,
        replacesBidId: replaces ?? null,
        actor: { type: 'SHOPPER', id: shopperId },
      },
    );
    if (!res.ok) throw new Error(`landHold refused: ${res.reason}`);
    return { id: bid.id, shopperId, amountCents } as Held;
  }

  const held = async (l: Listing, amountCents: number) => land(l, amountCents, await shopper());
  const raise = (l: Listing, b: Held, amountCents: number) =>
    land(l, amountCents, b.shopperId, b.id);

  interface Recorder {
    events: ListingEvent[];
    nudged: Nudge[];
    phrased: PhrasingContext[];
  }

  /**
   * Tests that script "the round is over" by moving `round_ends_at` to just now would otherwise
   * turn every earlier raise into a soft-close raise; they use a 1 ms window. Soft-close and
   * scaling tests pass their own timing.
   */
  const NO_SOFT_CLOSE = { ...UNSCALED_TIMING, softCloseMs: 1 };

  function deps(rec?: Recorder, extra: Partial<RoundsDeps> = {}, which: Db = db): RoundsDeps {
    return {
      db: which,
      timing: NO_SOFT_CLOSE,
      emit: async (tx: Queryable, listingId: string, event: ListingEvent) => {
        rec?.events.push(event);
        await tx.query(`SELECT pg_notify('listing_events', $1)`, [listingId]);
      },
      onNudge: (n) => {
        rec?.nudged.push(n);
      },
      ...extra,
    };
  }
  const depsWith = (rec: Recorder | undefined, extra: Partial<RoundsDeps>, which: Db) =>
    deps(rec, extra, which);
  const recorder = (): Recorder => ({ events: [], nudged: [], phrased: [] });

  async function row(id: string) {
    return one<{
      status: string;
      current_round: number;
      round_ends_at: Date;
      rounds_end_at: Date;
      rounds_started_at: Date;
      clear_deadline_at: Date;
      window_opens_at: Date;
      window_closes_at: Date;
      round_extensions: number;
      now: Date;
    }>(`SELECT *, clock_timestamp() AS now FROM listings WHERE id = $1`, [id]);
  }

  /** Script the clock: the current round ends `ms` from now (negative: already over). */
  const roundEndsIn = (id: string, ms: number) =>
    q(
      `UPDATE listings SET round_ends_at = clock_timestamp() + $2::float8 * interval '1 millisecond'
        WHERE id = $1`,
      [id, ms],
    );

  /** Listing in round 1 with three bidders for Q = 2: c is below the cutoff and nudged. */
  async function inRounds(rec?: Recorder, extra: Partial<RoundsDeps> = {}) {
    const l = await listing();
    const a = await held(l, 30_000);
    const b = await held(l, 20_000);
    const c = await held(l, 15_000);
    const started = await startRounds(deps(rec, extra), {
      listingId: l.id,
      brandId: l.brandId,
      actor: owner(l.brandId),
      targetQuantity: 2,
    });
    if (!started.ok) throw new Error(`start refused: ${JSON.stringify(started.error)}`);
    return { l, a, b, c };
  }

  const nudgeRows = (listingId: string) =>
    q<{ round: number; shopper_id: string; text: string; cutoff_cents: number }>(
      `SELECT round, shopper_id, text, cutoff_cents FROM nudges WHERE listing_id = $1 ORDER BY round`,
      [listingId],
    );

  describe('timer', () => {
    it('start and advance set round_ends_at = least(now() + 30 min, rounds_end_at)', async () => {
      const { l, c } = await inRounds();
      let r = await row(l.id);
      expect(r.round_ends_at.getTime() - r.rounds_started_at.getTime()).toBe(30 * MIN);
      await raise(l, c, 31_000);
      await roundEndsIn(l.id, -1);
      const res = await stepListing(deps(), l.id);
      expect(res).toMatchObject({ kind: 'ADVANCED', round: 2 });
      r = await row(l.id);
      expect(r.current_round).toBe(2);
      expect(r.round_ends_at.getTime() - r.now.getTime()).toBeGreaterThan(30 * MIN - 5_000);
      expect(r.round_ends_at.getTime() - r.now.getTime()).toBeLessThanOrEqual(30 * MIN);
    });

    it('a running round waits; the new round writes its nudge snapshot once', async () => {
      const rec = recorder();
      const { l, b, c } = await inRounds(rec);
      expect(await stepListing(deps(rec), l.id)).toMatchObject({ kind: 'WAIT', round: 1 });
      await raise(l, c, 31_000); // c now wins; b is below the cutoff
      await roundEndsIn(l.id, -1);
      const res = await stepListing(deps(rec), l.id);
      expect(res).toMatchObject({ kind: 'ADVANCED', round: 2, endedReason: null });
      const round2 = (await nudgeRows(l.id)).filter((n) => n.round === 2);
      expect(round2.map((n) => n.shopper_id)).toEqual([b.shopperId]);
      expect(round2[0]!.cutoff_cents).toBe(30_000);
      // Further ticks in round 2 do nothing.
      expect(await stepListing(deps(rec), l.id)).toMatchObject({ kind: 'WAIT', round: 2 });
      expect((await nudgeRows(l.id)).filter((n) => n.round === 2)).toHaveLength(1);
    });
  });

  describe('race (stub, from old HF-047)', () => {
    it('two runner instances ticking: each round advances once, one nudge per (listing, round, shopper)', async () => {
      const rec = recorder();
      let claudeCalls = 0;
      const phraser: NudgePhraser = async () => {
        claudeCalls++;
        await new Promise((r) => setTimeout(r, 150)); // overlap the two runners
        return CLAUDE_TEMPLATE;
      };
      const { l, a, b, c } = await inRounds(rec);
      const extra = { phraser };
      // Bidders keep raising so rounds keep advancing.
      const bids = { a, b, c };
      for (let round = 1; round <= 3; round++) {
        const losers = (await nudgeRows(l.id)).filter((n) => n.round === round);
        for (const n of losers) {
          const key = (Object.keys(bids) as (keyof typeof bids)[]).find(
            (k) => bids[k].shopperId === n.shopper_id,
          )!;
          bids[key] = await raise(l, bids[key], bids[key].amountCents + 20_000);
        }
        await roundEndsIn(l.id, -1);
        const before = rec.nudged.length;
        const results = await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            i % 2 === 0 ? tickRounds(deps(rec, extra, db)) : tickRounds(deps(rec, extra, db2)),
          ),
        );
        const advanced = results.map((m) => m.get(l.id)).filter((r) => r?.kind === 'ADVANCED');
        expect(advanced).toHaveLength(1);
        expect((await row(l.id)).current_round).toBe(round + 1);
        // onNudge once per new nudge, across both instances.
        const rows = (await nudgeRows(l.id)).filter((n) => n.round === round + 1);
        expect(rows.length).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, 20));
        expect(rec.nudged.length - before).toBe(rows.length);
      }
      // One Claude call per round (rounds 2–4), even with two instances.
      expect(claudeCalls).toBe(3);
      const dup = await q(
        `SELECT round, shopper_id FROM nudges WHERE listing_id = $1
          GROUP BY round, shopper_id HAVING count(*) > 1`,
        [l.id],
      );
      expect(dup).toEqual([]);
      const startedEvents = rec.events.filter((e) => e.type === 'round.started');
      expect(startedEvents.map((e) => (e as { round: number }).round)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('soft close', () => {
    const deps = (rec?: Recorder, extra: Partial<RoundsDeps> = {}, which: Db = db) =>
      depsWith(rec, { timing: UNSCALED_TIMING, ...extra }, which);
    it('a raise in the last 5 min extends the round by 10 min (once), with round.extended', async () => {
      const rec = recorder();
      const { l, c } = await inRounds(rec);
      await roundEndsIn(l.id, 2 * MIN);
      const before = (await row(l.id)).round_ends_at.getTime();
      await raise(l, c, 31_000);
      expect(await stepListing(deps(rec), l.id)).toMatchObject({ kind: 'WAIT', extended: 1 });
      const after = await row(l.id);
      expect(after.round_ends_at.getTime() - before).toBe(10 * MIN);
      expect(after.round_extensions).toBe(1);
      const ext = rec.events.filter((e) => e.type === 'round.extended');
      expect(ext).toHaveLength(1);
      expect(ext[0]).toMatchObject({ round: 1, roundEndsAt: after.round_ends_at.toISOString() });
      // The same raise never extends twice.
      expect(await stepListing(deps(rec), l.id)).toMatchObject({ kind: 'WAIT', extended: 0 });
      expect((await row(l.id)).round_ends_at.getTime()).toBe(after.round_ends_at.getTime());
    });

    it('a raise earlier in the round does not extend it', async () => {
      const { l, c } = await inRounds();
      await roundEndsIn(l.id, 6 * MIN);
      const before = (await row(l.id)).round_ends_at.getTime();
      await raise(l, c, 31_000);
      expect(await stepListing(deps(), l.id)).toMatchObject({ kind: 'WAIT', extended: 0 });
      expect((await row(l.id)).round_ends_at.getTime()).toBe(before);
    });

    it('two raises at once extend once each; two runners never double-extend', async () => {
      const rec = recorder();
      const { l, b, c } = await inRounds(rec);
      await roundEndsIn(l.id, 2 * MIN);
      const before = (await row(l.id)).round_ends_at.getTime();
      await Promise.all([raise(l, b, 33_000), raise(l, c, 34_000)]);
      await Promise.all([
        stepListing(deps(rec), l.id),
        stepListing(deps(rec, {}, db2), l.id),
        stepListing(deps(rec), l.id),
      ]);
      await stepListing(deps(rec, {}, db2), l.id);
      const after = await row(l.id);
      expect(after.round_ends_at.getTime() - before).toBe(20 * MIN);
      expect(after.round_extensions).toBe(2);
      expect(rec.events.filter((e) => e.type === 'round.extended')).toHaveLength(2);
    });

    it('never past rounds_end_at', async () => {
      const rec = recorder();
      const { l, a, b, c } = await inRounds(rec);
      // 2 min left in the round, 14 min left in rounds.
      await q(
        `UPDATE listings SET round_ends_at = clock_timestamp() + interval '2 minutes',
                             rounds_end_at = clock_timestamp() + interval '14 minutes'
          WHERE id = $1`,
        [l.id],
      );
      await Promise.all([raise(l, a, 35_000), raise(l, b, 33_000), raise(l, c, 34_000)]);
      await stepListing(deps(rec), l.id);
      const after = await row(l.id);
      // +10 min, then only the 2 min left to the cap; the third raise has nothing to extend.
      expect(after.round_ends_at.getTime()).toBe(after.rounds_end_at.getTime());
      expect(after.round_extensions).toBe(2);
      expect(rec.events.filter((e) => e.type === 'round.extended')).toHaveLength(2);
    });
  });

  describe('end rules', () => {
    const ended = (rec: Recorder) =>
      rec.events.filter((e) => e.type === 'round.ended') as Extract<
        ListingEvent,
        { type: 'round.ended' }
      >[];

    it('the rounds cap (rounds_end_at) passed → round.ended CAP_REACHED, then the tick stops', async () => {
      const rec = recorder();
      const { l } = await inRounds(rec);
      await q(
        `UPDATE listings SET rounds_end_at = clock_timestamp() - interval '1 second',
                             round_ends_at = clock_timestamp() - interval '1 second'
          WHERE id = $1`,
        [l.id],
      );
      expect(await stepListing(deps(rec), l.id)).toMatchObject({
        kind: 'ENDED',
        reason: 'CAP_REACHED',
      });
      expect(ended(rec)).toMatchObject([{ reason: 'CAP_REACHED', round: 1 }]);
      expect(await roundsListingIds(db.pool)).not.toContain(l.id);
      expect(await stepListing(deps(rec), l.id)).toEqual({ kind: 'IDLE' });
      expect(ended(rec)).toHaveLength(1);
    });

    it('a round that nudged and saw no raise → NO_RAISES, rounds_end_at = now(), clear deadline ≤ now() + 6h', async () => {
      const rec = recorder();
      const { l } = await inRounds(rec);
      await roundEndsIn(l.id, -1);
      expect(await stepListing(deps(rec), l.id)).toMatchObject({
        kind: 'ENDED',
        reason: 'NO_RAISES',
      });
      const r = await row(l.id);
      expect(r.now.getTime() - r.rounds_end_at.getTime()).toBeLessThan(5_000);
      expect(r.clear_deadline_at.getTime()).toBeLessThanOrEqual(
        r.rounds_end_at.getTime() + 6 * HOUR,
      );
      expect(ended(rec)).toMatchObject([{ reason: 'NO_RAISES' }]);
      expect(await stepListing(deps(rec), l.id)).toEqual({ kind: 'IDLE' });
    });

    it('nobody below the cutoff in the new round → NONE_BELOW_CUTOFF', async () => {
      const rec = recorder();
      const { l, c } = await inRounds(rec);
      await raise(l, c, 31_000);
      await setRoundsTarget(deps(rec), {
        listingId: l.id,
        brandId: l.brandId,
        actor: owner(l.brandId),
        targetQuantity: 3,
      });
      await roundEndsIn(l.id, -1);
      expect(await stepListing(deps(rec), l.id)).toMatchObject({
        kind: 'ADVANCED',
        round: 2,
        endedReason: 'NONE_BELOW_CUTOFF',
      });
      expect(ended(rec)).toMatchObject([{ reason: 'NONE_BELOW_CUTOFF', round: 2 }]);
      expect(await roundsListingIds(db.pool)).not.toContain(l.id);
    });

    it('brand stop → round.ended BRAND_STOPPED and the tick leaves the listing alone', async () => {
      const rec = recorder();
      const { l } = await inRounds(rec);
      await stopRounds(deps(rec), { listingId: l.id, brandId: l.brandId, actor: owner(l.brandId) });
      expect(ended(rec)).toMatchObject([{ reason: 'BRAND_STOPPED' }]);
      await roundEndsIn(l.id, -1);
      expect(await stepListing(deps(rec), l.id)).toEqual({ kind: 'IDLE' });
      expect(ended(rec)).toHaveLength(1);
    });

    it('the tick stops after Clear: unsubscribed, no more rounds or events', async () => {
      const rec = recorder();
      const { l, c } = await inRounds(rec);
      const subscribed = new Set<string>();
      const ticker = startRoundsTicker(deps(rec), {
        intervalMs: 60_000,
        subscribe: (id) => {
          subscribed.add(id);
          return () => subscribed.delete(id);
        },
      });
      try {
        await ticker.runOnce();
        expect(subscribed.has(l.id)).toBe(true);
        await raise(l, c, 31_000);
        // Clear moves the listing out of ROUNDS (HF-027); the round is overdue.
        await q(`UPDATE listings SET status = 'CLEARING' WHERE id = $1`, [l.id]);
        await roundEndsIn(l.id, -1);
        const n = rec.events.length;
        await ticker.runOnce();
        expect(subscribed.has(l.id)).toBe(false);
        expect(await stepListing(deps(rec), l.id)).toEqual({ kind: 'IDLE' });
        expect((await row(l.id)).current_round).toBe(1);
        expect(rec.events.length).toBe(n);
      } finally {
        ticker.stop();
      }
    });
  });

  describe('ROUNDS_TIME_SCALE', () => {
    it('0.0667 scales rounds, soft close and extension; clear_deadline_at and hold age stay unscaled', async () => {
      const scaled = roundsTiming(0.0667);
      const run = async (timing: typeof scaled) => {
        const l = await listing({ closesIn: 24 });
        const a = await held(l, 30_000);
        await held(l, 20_000);
        const c = await held(l, 15_000);
        const holdsBefore = await q(
          `SELECT id, authorized_at, authorization_expires_at FROM bids WHERE listing_id = $1 ORDER BY id`,
          [l.id],
        );
        await startRounds(deps(undefined, { timing }), {
          listingId: l.id,
          brandId: l.brandId,
          actor: owner(l.brandId),
          targetQuantity: 2,
        });
        const r = await row(l.id);
        return { l, a, c, r, holdsBefore };
      };
      const plain = await run(UNSCALED_TIMING);
      const fast = await run(scaled);
      const rel = (x: { r: Awaited<ReturnType<typeof row>> }, d: Date) =>
        d.getTime() - x.r.rounds_started_at.getTime();

      // Scaled: ~2-min rounds, 24-min cap.
      expect(rel(fast, fast.r.round_ends_at)).toBe(scaled.roundMs);
      expect(rel(fast, fast.r.rounds_end_at)).toBe(scaled.capMs);
      expect(rel(plain, plain.r.round_ends_at)).toBe(30 * MIN);
      expect(rel(plain, plain.r.rounds_end_at)).toBe(6 * HOUR);
      // clear_deadline_at is identical to the unscaled run (relative to the same start).
      expect(rel(fast, fast.r.clear_deadline_at)).toBe(rel(plain, plain.r.clear_deadline_at));

      // Soft close scales: a raise 15 s before the end (inside the 20 s window) adds 40 s.
      await roundEndsIn(fast.l.id, 15_000);
      const before = (await row(fast.l.id)).round_ends_at.getTime();
      await raise(fast.l, fast.c, 31_000);
      await stepListing(deps(undefined, { timing: scaled }), fast.l.id);
      expect((await row(fast.l.id)).round_ends_at.getTime() - before).toBe(scaled.extensionMs);
      // 25 s before the end is outside the scaled window.
      const plainC = await raise(plain.l, plain.c, 31_000);
      void plainC;
      await roundEndsIn(fast.l.id, 25_000);
      const b2 = (await row(fast.l.id)).round_ends_at.getTime();
      const latest = await one<{ id: string; shopper_id: string; amount_cents: number }>(
        `SELECT id, shopper_id, amount_cents FROM bids WHERE listing_id = $1 AND status = 'HELD'
          ORDER BY amount_cents ASC LIMIT 1`,
        [fast.l.id],
      );
      await raise(
        fast.l,
        { id: latest.id, shopperId: latest.shopper_id, amountCents: latest.amount_cents },
        latest.amount_cents + 5_000,
      );
      await stepListing(deps(undefined, { timing: scaled }), fast.l.id);
      expect((await row(fast.l.id)).round_ends_at.getTime()).toBe(b2);

      // Ending rounds (NO_RAISES) keeps the unscaled 6 h clear window.
      // (Scripting "round over" right after a raise would make it a soft-close raise, so these
      // two steps use a 1 ms window.)
      const noWindow = { timing: { ...scaled, softCloseMs: 1 } };
      await roundEndsIn(fast.l.id, -1);
      expect(await stepListing(deps(undefined, noWindow), fast.l.id)).toMatchObject({
        kind: 'ADVANCED', // raises seen in round 1
      });
      await roundEndsIn(fast.l.id, -1);
      expect(await stepListing(deps(undefined, noWindow), fast.l.id)).toMatchObject({
        kind: 'ENDED',
        reason: 'NO_RAISES',
      });
      const end = await row(fast.l.id);
      expect(end.clear_deadline_at.getTime()).toBe(
        Math.min(fast.r.clear_deadline_at.getTime(), end.rounds_end_at.getTime() + 6 * HOUR),
      );

      // Hold age is never touched: the original holds keep their PayPal times.
      for (const x of [plain, fast]) {
        const after = await q(
          `SELECT id, authorized_at, authorization_expires_at FROM bids WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [x.holdsBefore.map((h) => h.id)],
        );
        expect(after).toEqual(x.holdsBefore);
      }
    });
  });

  describe('Claude phrasing', () => {
    async function advanceWith(phraser: NudgePhraser | undefined, timeoutMs?: number) {
      const rec = recorder();
      const { l, c } = await inRounds(rec);
      await raise(l, c, 31_000);
      await roundEndsIn(l.id, -1);
      const wrapped: NudgePhraser | undefined = phraser
        ? (ctx, signal) => {
            rec.phrased.push(ctx);
            return phraser(ctx, signal);
          }
        : undefined;
      const started = Date.now();
      const res = await stepListing(
        deps(rec, { phraser: wrapped, phrasingTimeoutMs: timeoutMs }),
        l.id,
      );
      return { l, rec, res, ms: Date.now() - started };
    }

    it('fills the round template with numbers from code', async () => {
      const { l, res, rec } = await advanceWith(async () => CLAUDE_TEMPLATE);
      expect(res).toMatchObject({ kind: 'ADVANCED', round: 2 });
      const n = (await nudgeRows(l.id)).filter((x) => x.round === 2);
      expect(n).toHaveLength(1);
      expect(n[0]!.text).toBe(
        'Your $200 bid sits under the $300 cutoff for 2 units. Raise to $303?',
      );
      expect(rec.phrased).toHaveLength(1);
    });

    it.each([
      [
        'down',
        async () => {
          throw new Error('anthropic 529');
        },
        undefined,
      ],
      ['slow (timeout)', () => new Promise<string>(() => {}), 200],
      [
        'inventing numbers',
        async () => 'Only 2 left! Raise from {yourBid} past {cutoff} to {suggested}',
        undefined,
      ],
    ] as [string, NudgePhraser, number | undefined][])(
      'Claude %s → template text in the same tick',
      async (_name, phraser, timeoutMs) => {
        const { l, res, ms } = await advanceWith(phraser, timeoutMs);
        expect(res).toMatchObject({ kind: 'ADVANCED', round: 2 });
        expect(ms).toBeLessThan(3_000);
        const n = (await nudgeRows(l.id)).filter((x) => x.round === 2);
        expect(n).toHaveLength(1);
        expect(n[0]!.text).toBe(
          nudgeText({ yourBidCents: 20_000, cutoffCents: 30_000, suggestedCents: 30_300 }),
        );
      },
    );

    it('the floor never reaches the model or the text', async () => {
      const { l, rec } = await advanceWith(async () => CLAUDE_TEMPLATE);
      const ctx = rec.phrased[0]!;
      expect(Object.keys(ctx).sort()).toEqual(['brandName', 'listingId', 'productTitle', 'round']);
      const floor = 10_000;
      const s = JSON.stringify(ctx);
      expect(s).not.toContain(String(floor));
      expect(s).not.toContain('$100');
      for (const n of await nudgeRows(l.id)) {
        expect(n.text).not.toContain('$100.00');
        expect(n.text).not.toMatch(/\$100\b/);
      }
    });
  });

  describe('end to end (stub): 20 SIM agents, real ticker, scaled rounds', () => {
    it('agents raise on their nudges for 2 rounds; round 3 sees no raise and ends NO_RAISES', async () => {
      const rec = recorder();
      // A very fast clock: 1.5 s rounds, ticking every 100 ms.
      const timing = { roundMs: 1_500, softCloseMs: 200, extensionMs: 300, capMs: 60_000 };
      const l = await listing({ quantity: 30 });
      const agents: Held[] = [];
      for (let i = 0; i < 20; i++) {
        const sid = (
          await one<{ id: string }>(
            `INSERT INTO shoppers (display_name, is_simulated) VALUES ($1, true) RETURNING id`,
            [`SIM ${i}`],
          )
        ).id;
        agents.push(await land(l, 15_000 + i * 500, sid));
      }
      const current = new Map(agents.map((a) => [a.shopperId, a]));
      const raises: Promise<unknown>[] = [];
      // Stand-in for HF-038b's auto-raise runner: raise once to the suggested amount, rounds 1–2.
      const onNudge = (n: Nudge) => {
        if (n.round > 2) return;
        const bid = current.get(n.shopperId)!;
        raises.push(raise(l, bid, n.suggestedCents).then((nb) => current.set(n.shopperId, nb)));
      };
      const d = deps(rec, { timing, onNudge });
      const started = await startRounds(d, {
        listingId: l.id,
        brandId: l.brandId,
        actor: owner(l.brandId),
        targetQuantity: 12,
      });
      expect(started.ok).toBe(true);
      // Two instances' tickers on one DB.
      const t1 = startRoundsTicker(d, { intervalMs: 100 });
      const t2 = startRoundsTicker({ ...d, db: db2 }, { intervalMs: 100 });
      try {
        const deadline = Date.now() + 20_000;
        while (!rec.events.some((e) => e.type === 'round.ended') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        t1.stop();
        t2.stop();
      }
      await Promise.allSettled(raises);
      const endedEv = rec.events.find((e) => e.type === 'round.ended');
      expect(endedEv).toMatchObject({ reason: 'NO_RAISES', round: 3 });
      const perRound = await q<{ round: number; n: number; dup: number }>(
        `SELECT round, count(*)::int AS n, count(*)::int - count(DISTINCT shopper_id)::int AS dup
           FROM nudges WHERE listing_id = $1 GROUP BY round ORDER BY round`,
        [l.id],
      );
      expect(perRound.map((r) => r.round)).toEqual([1, 2, 3]);
      expect(perRound.every((r) => r.dup === 0 && r.n > 0)).toBe(true);
      // Every round-1 and round-2 nudge produced a landed raise.
      const landed = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM bids n JOIN bids o ON o.id = n.replaces_bid_id
          WHERE n.listing_id = $1 AND o.void_reason = 'REPLACED'`,
        [l.id],
      );
      expect(landed.n).toBe(perRound[0]!.n + perRound[1]!.n);
      const audits = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE listing_id = $1 AND action = 'NUDGE_SENT'`,
        [l.id],
      );
      expect(audits.n).toBe(perRound.reduce((s, r) => s + r.n, 0));
      expect((await row(l.id)).status).toBe('ROUNDS'); // frozen until Clear
    }, 30_000);
  });
});
