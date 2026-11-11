/**
 * HF-037b: the console's raises feed (`loadRoundsActivity`) on real Postgres with FakePayPal
 * (HF-004). Raises go through the real `landHold` swap; the timer is the real `stepListing`.
 * Needs TEST_DATABASE_URL; skipped when unset.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run packages/core/src/rounds/activity
 *
 * Time is scripted by moving `round_ends_at` in the DB rather than waiting.
 */
import { roundsActivitySchema } from '@holdfast/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { landHold } from '../money/land-hold.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from '../money/test-harness.js';
import { FakePayPal } from '../paypal/fake.js';
import { orderRequestId } from '../paypal/ids.js';
import type { PayPalClient } from '../paypal/types.js';
import { NotFoundError } from '../tenancy.js';
import { loadRoundsActivity } from './activity.js';
import { startRounds, stopRounds, type RoundsActor, type RoundsDeps } from './rounds.js';
import { stepListing } from './tick.js';
import { UNSCALED_TIMING } from './timing.js';

const MIN = 60_000;

interface Listing {
  id: string;
  brandId: string;
}
interface Held {
  id: string;
  shopperId: string;
  amountCents: number;
}

describe.skipIf(!TEST_DATABASE_URL)('HF-037b rounds activity (Postgres + FakePayPal)', () => {
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
  }, 60_000);

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.pool.query(sql, params)).rows[0] as T;

  const owner = (brandId: string): RoundsActor => ({
    type: 'BRAND_USER',
    id: `owner-of-${brandId}`,
    role: 'OWNER',
  });

  /** No soft close unless a test asks for it (scripted round ends would trigger it). */
  const deps = (timing = { ...UNSCALED_TIMING, softCloseMs: 1 }): RoundsDeps => ({
    db,
    timing,
    emit: async () => {},
  });

  async function listing(): Promise<Listing> {
    const brand = await one<{ id: string }>(
      `INSERT INTO brands (name, payout_email) VALUES ('Aurel', 'p@aurel.example') RETURNING id`,
    );
    const product = await one<{ id: string }>(
      `INSERT INTO products (title) VALUES ('Aurel One') RETURNING id`,
    );
    const row = await one<{ id: string }>(
      `INSERT INTO listings (brand_id, product_id, status, quantity, floor_cents,
                             window_opens_at, window_closes_at)
       VALUES ($1, $2, 'OPEN', 10, 10000, now() - interval '1 hour', now() + interval '24 hours')
       RETURNING id`,
      [brand.id, product.id],
    );
    return { id: row.id, brandId: brand.id };
  }

  async function shopper(simulated = false): Promise<string> {
    return (
      await one<{ id: string }>(
        `INSERT INTO shoppers (display_name, is_simulated) VALUES ('Sam', $1) RETURNING id`,
        [simulated],
      )
    ).id;
  }

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

  const raise = (l: Listing, b: Held, amountCents: number) =>
    land(l, amountCents, b.shopperId, b.id);

  const roundEndsIn = (id: string, ms: number) =>
    db.pool.query(
      `UPDATE listings SET round_ends_at = clock_timestamp() + $2::float8 * interval '1 millisecond'
        WHERE id = $1`,
      [id, ms],
    );

  /** Q = 2 over $300 / $200 / $150 (c simulated): c is below the cutoff in round 1. */
  async function inRounds() {
    const l = await listing();
    const a = await land(l, 30_000, await shopper());
    const b = await land(l, 20_000, await shopper());
    const c = await land(l, 15_000, await shopper(true));
    const started = await startRounds(deps(), {
      listingId: l.id,
      brandId: l.brandId,
      actor: owner(l.brandId),
      targetQuantity: 2,
    });
    if (!started.ok) throw new Error(`start refused: ${JSON.stringify(started.error)}`);
    return { l, a, b, c };
  }

  const activity = async (l: Listing) =>
    roundsActivitySchema.parse(await loadRoundsActivity(db, l.brandId, l.id));

  it('before rounds: no rounds, raises or gross; another brand is NOT_FOUND', async () => {
    const l = await listing();
    await land(l, 30_000, await shopper());
    expect(await activity(l)).toMatchObject({
      status: 'OPEN',
      currentRound: null,
      expectedGrossCents: null,
      rounds: [],
      raises: [],
      extensions: [],
      ended: null,
    });
    const other = await listing();
    await expect(loadRoundsActivity(db, other.brandId, l.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a raise: bid.raised contract, book label, SIM flag, round summary and expected gross Δ', async () => {
    const { l, c } = await inRounds();
    const start = await activity(l);
    expect(start.rounds).toEqual([
      expect.objectContaining({
        round: 1,
        nudged: 1,
        raised: 0,
        grossAtStartCents: 50_000,
        grossDeltaCents: 0,
      }),
    ]);
    expect(start.expectedGrossCents).toBe(50_000);

    const c2 = await raise(l, c, 31_000);
    const after = await activity(l);
    expect(after.raises).toEqual([
      expect.objectContaining({
        bidId: c2.id,
        replacesBidId: c.id,
        oldCents: 15_000,
        newCents: 31_000,
        // Third shopper on the listing, as in the book and the grid.
        shopperLabel: 'Shopper #1003',
        source: 'OFFER_PAGE',
        isSimulated: true,
        round: 1,
      }),
    ]);
    // a $300 + c $310 now win at Q = 2.
    expect(after.expectedGrossCents).toBe(61_000);
    expect(after.rounds[0]).toMatchObject({ raised: 1, grossDeltaCents: 11_000 });

    // Raises before rounds started are not in the feed.
    const l2 = await listing();
    const x = await land(l2, 20_000, await shopper());
    await raise(l2, x, 21_000);
    expect((await activity(l2)).raises).toEqual([]);
  });

  it('a late raise: the extension with how far the round moved', async () => {
    const { l, c } = await inRounds();
    await roundEndsIn(l.id, 2 * MIN);
    await raise(l, c, 31_000);
    expect(await stepListing(deps(UNSCALED_TIMING), l.id)).toMatchObject({ extended: 1 });
    const { extensions } = await activity(l);
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).toMatchObject({ round: 1, extendedByMs: 10 * MIN });
    const row = await one<{ round_ends_at: Date }>(
      `SELECT round_ends_at FROM listings WHERE id = $1`,
      [l.id],
    );
    expect(extensions[0]!.roundEndsAt).toBe(row.round_ends_at.toISOString());
  });

  it('two rounds: raises land in their round, Δ per round, then NO_RAISES ends them', async () => {
    const { l, b, c } = await inRounds();
    await raise(l, c, 31_000); // round 1: c now wins; b ($200) is below the cutoff
    await roundEndsIn(l.id, -1);
    expect(await stepListing(deps(), l.id)).toMatchObject({ kind: 'ADVANCED', round: 2 });
    const b2 = await raise(l, b, 32_000); // round 2: b back above
    const mid = await activity(l);
    expect(mid.currentRound).toBe(2);
    expect(mid.rounds.map((r) => [r.round, r.nudged, r.raised])).toEqual([
      [1, 1, 1],
      [2, 1, 1],
    ]);
    expect(mid.rounds[0]).toMatchObject({ grossAtStartCents: 50_000, grossDeltaCents: 11_000 });
    // Round 2 started at $310 + $300; now $320 + $310.
    expect(mid.rounds[1]).toMatchObject({ grossAtStartCents: 61_000, grossDeltaCents: 2_000 });
    expect(mid.raises.map((r) => [r.bidId, r.round])).toEqual([
      [b2.id, 2],
      [expect.any(String), 1],
    ]);

    // Round 3 nudges a ($300); nobody raises, so the tick ends rounds with NO_RAISES.
    await roundEndsIn(l.id, -1);
    expect(await stepListing(deps(), l.id)).toMatchObject({ kind: 'ADVANCED', round: 3 });
    await roundEndsIn(l.id, -1);
    expect(await stepListing(deps(), l.id)).toMatchObject({ kind: 'ENDED', reason: 'NO_RAISES' });
    expect((await activity(l)).ended).toMatchObject({ round: 3, reason: 'NO_RAISES' });
  });

  it('brand stop → BRAND_STOPPED; nobody below the cutoff → NONE_BELOW_CUTOFF', async () => {
    const { l } = await inRounds();
    const stopped = await stopRounds(deps(), {
      listingId: l.id,
      brandId: l.brandId,
      actor: owner(l.brandId),
    });
    expect(stopped.ok).toBe(true);
    expect((await activity(l)).ended).toMatchObject({ round: 1, reason: 'BRAND_STOPPED' });

    const l2 = await listing();
    await land(l2, 30_000, await shopper());
    const started = await startRounds(deps(), {
      listingId: l2.id,
      brandId: l2.brandId,
      actor: owner(l2.brandId),
      targetQuantity: 2,
    });
    expect(started.ok && started.state.endedReason).toBe('NONE_BELOW_CUTOFF');
    expect((await activity(l2)).ended).toMatchObject({ round: 1, reason: 'NONE_BELOW_CUTOFF' });
  });
});
