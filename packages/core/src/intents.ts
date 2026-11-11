import { formatUsd, isBiddable, MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS } from '@holdfast/shared';
import { audit } from './audit.js';
import { MOVED_ACTION, moveBid, type MoveBidResult } from './bid-move.js';
import { placeBid, type PlaceBidDeps, type PlaceBidResult } from './bids.js';
import type { Queryable } from './db.js';
import { createMandate } from './mandates.js';
import type { Actor } from './money/deps.js';
import type { MandateRow } from './money/rows.js';
import { SQL_NOW, transition } from './money/transition.js';
import { suggestedBidCents } from './offers/likely-band.js';

/**
 * Multi-product intents and the move rule (HF-052; features/04 §Logic 3–4, §Edge cases,
 * data-model §intents).
 *
 * An intent is one want across several products ("A7-class headphones under $230": Aurel One or
 * Nova X). It has exactly **one live bid at a time** (`bids_one_held_per_intent`), and plain code
 * here, not the model, decides where that bid sits:
 *
 * - **Pick** (`pickBook`): among the intent's biddable books, the one whose required bid is lowest
 *   relative to the shopper's max, then the earliest close. The required bid is floor-blind (M22):
 *   what it takes to rank in the top `quantity` of the *other* shoppers' eligible bids.
 * - **Move** (`decideIntent`): when the current book closes lost (the bid is released as `LOST`, or
 *   the listing was cancelled / expired), place in the best remaining book; when the bid is
 *   currently out of the money and a better book is open, `moveBid` swaps it there (D1). A winning
 *   bid never moves; a bid still in Clear's hands (`LOST` before its void, which a promotion can
 *   still turn into WON) is waited out.
 * - **No open book**: the intent stays OPEN and is re-checked by the `intent-move-rule` job, which
 *   places as soon as a matching book opens.
 *
 * `create_intent` stores the intent with its mandate **PAUSED** (no draft status); the shopper's
 * confirm (`activateIntent`) makes it ACTIVE and runs the rule once. Every placement and move is
 * audited with a one-sentence `why`, which the agent quotes for "why did you move my bid?".
 */

/** Released reasons that mean "the book closed without this bid": the intent places again. */
export const REPLACE_AFTER_VOID_REASONS = [
  'LOST',
  'WINDOW_CLOSED',
  'WINDOW_EXPIRED',
  'EXPIRED',
] as const;
/** An intent lists 1–5 products. */
export const MAX_INTENT_PRODUCTS = 5;
/**
 * Failed move attempts (declined, or refused at landing) the rule makes for one held bid before it
 * stops trying, so a declining card is not retried every minute.
 */
export const MAX_MOVE_ATTEMPTS = 3;
/** Audit action for a placement made by the move rule (the first bid, or after a lost book). */
export const INTENT_PLACED_ACTION = 'INTENT_BID_PLACED';

// ---------------------------------------------------------------------------------------------
// Pure rule (unit-tested)
// ---------------------------------------------------------------------------------------------

export interface BookCandidate {
  listingId: string;
  title: string | null;
  brandName: string | null;
  quantity: number;
  closesAt: Date;
  /** Eligible (D8) amounts of the *other* shoppers' bids on this book. */
  otherAmountsCents: readonly number[];
  bestPublicPriceCents: number | null;
}

/**
 * The bid that ranks in the top `quantity` against the other shoppers' eligible bids: 1¢ above
 * the `quantity`-th highest (ties go to the earlier bid), or the minimum while seats are open.
 * Floor-blind on purpose (M22).
 */
export function requiredBidCents(otherAmountsCents: readonly number[], quantity: number): number {
  if (otherAmountsCents.length < quantity) return MIN_AMOUNT_CENTS;
  const cutoff = [...otherAmountsCents].sort((a, b) => b - a)[quantity - 1]!;
  return Math.min(MAX_AMOUNT_CENTS, cutoff + 1);
}

export interface PickedBook {
  book: BookCandidate;
  requiredCents: number;
  /** What the intent bids there. */
  amountCents: number;
}

/**
 * The amount bid in a picked book: at least the required bid, the floor-blind suggestion (≈18%
 * under the public low) when there is one, never above the shopper's max.
 */
export function intentBidCents(
  requiredCents: number,
  publicPriceCents: number | null,
  maxCents: number,
): number {
  const suggested = suggestedBidCents(publicPriceCents);
  return Math.min(maxCents, Math.max(requiredCents, suggested ?? maxCents));
}

/** Lowest required bid relative to the max, then earliest close, then id. Null if none fits. */
export function pickBook(
  books: readonly BookCandidate[],
  maxCents: number,
  exclude: ReadonlySet<string> = new Set(),
): PickedBook | null {
  const fits = books
    .filter((b) => !exclude.has(b.listingId))
    .map((book) => ({
      book,
      requiredCents: requiredBidCents(book.otherAmountsCents, book.quantity),
    }))
    .filter((p) => p.requiredCents <= maxCents)
    .sort(
      (a, b) =>
        a.requiredCents / maxCents - b.requiredCents / maxCents ||
        a.book.closesAt.getTime() - b.book.closesAt.getTime() ||
        (a.book.listingId < b.book.listingId ? -1 : 1),
    );
  const best = fits[0];
  if (!best) return null;
  return {
    ...best,
    amountCents: intentBidCents(best.requiredCents, best.book.bestPublicPriceCents, maxCents),
  };
}

export interface IntentBid {
  id: string;
  listingId: string;
  status: string;
  voidReason: string | null;
  amountCents: number;
  placedAt: Date;
  /** Title of the bid's product, for the explanation. */
  title: string | null;
}

export interface IntentState {
  intentStatus: string;
  mandateStatus: string | null;
  maxCents: number;
  /** All of the intent's bids. */
  bids: readonly IntentBid[];
  /** Biddable books for the intent's products, without books where the shopper has another bid. */
  books: readonly BookCandidate[];
}

export type IntentDecision =
  | { kind: 'place'; listingId: string; amountCents: number; why: string }
  | { kind: 'move'; bidId: string; toListingId: string; amountCents: number; why: string }
  /** Nothing to do now; `why` says what the intent is waiting for. */
  | { kind: 'stay' | 'watch' | 'done'; why: string };

const WON_STATUSES = new Set(['WON', 'CAPTURED', 'SHIPPED']);
const IN_FLIGHT = new Set(['PENDING_APPROVAL', 'LOST']);
/** A bid that never became a live hold, or was released: a failed attempt if newer than the HELD bid. */
const NEVER_HELD = new Set(['HOLD_FAILED', 'ABANDONED', 'VOIDING', 'VOIDED']);
const bookName = (b: { title: string | null; brandName?: string | null }) =>
  b.title ? `the ${b.title} book` : 'another book';

/** The move rule as a pure function (features/04 §Logic 4). */
export function decideIntent(state: IntentState): IntentDecision {
  if (state.intentStatus !== 'OPEN')
    return { kind: 'done', why: `The intent is ${state.intentStatus}.` };
  if (state.bids.some((b) => WON_STATUSES.has(b.status))) {
    return { kind: 'done', why: 'A bid for this intent won.' };
  }
  if (state.mandateStatus !== 'ACTIVE') {
    return { kind: 'stay', why: 'The intent is waiting for the shopper to approve it.' };
  }
  if (state.bids.some((b) => IN_FLIGHT.has(b.status))) {
    // A hold in flight, or a LOST bid a promotion could still turn into a win: never two.
    return { kind: 'stay', why: 'A bid for this intent is still being decided.' };
  }
  const max = state.maxCents;
  const held = state.bids.find((b) => b.status === 'HELD');

  if (held) {
    const current = state.books.find((b) => b.listingId === held.listingId);
    // Not biddable any more (rounds, clearing): Clear decides; moving out would not help.
    if (!current)
      return { kind: 'stay', why: 'The current book is closing; waiting for the result.' };
    const currentRequired = requiredBidCents(current.otherAmountsCents, current.quantity);
    if (held.amountCents >= currentRequired) {
      return { kind: 'stay', why: `Your ${formatUsd(held.amountCents)} bid is currently winning.` };
    }
    const best = pickBook(state.books, max, new Set([held.listingId]));
    if (!best || best.requiredCents >= Math.min(currentRequired, max + 1)) {
      return { kind: 'stay', why: 'No other open book is likelier to clear within your max.' };
    }
    // While a bid is HELD, the intent's only newer bids are move attempts from it that failed.
    const failedMoves = state.bids.filter(
      (b) => b.placedAt.getTime() > held.placedAt.getTime() && NEVER_HELD.has(b.status),
    ).length;
    if (failedMoves >= MAX_MOVE_ATTEMPTS) {
      return {
        kind: 'stay',
        why: `Moving your ${formatUsd(held.amountCents)} bid failed ${failedMoves} times, so it stays where it is.`,
      };
    }
    return {
      kind: 'move',
      bidId: held.id,
      toListingId: best.book.listingId,
      amountCents: best.amountCents,
      why: `Your ${formatUsd(held.amountCents)} bid in ${bookName(current)} was below the ${formatUsd(
        currentRequired,
      )} needed to win there, and ${bookName(best.book)} can clear at ${formatUsd(
        best.amountCents,
      )}, within your ${formatUsd(max)} max.`,
    };
  }

  const last = [...state.bids].sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())[0];
  if (last && !(REPLACE_AFTER_VOID_REASONS as readonly string[]).includes(last.voidReason ?? '')) {
    // Cancelled, price drop, paused, declined …: the shopper's or PayPal's call, not the rule's.
    return { kind: 'done', why: 'The last bid for this intent was released and not replaced.' };
  }
  const best = pickBook(state.books, max);
  if (!best) {
    return {
      kind: 'watch',
      why: `No open book for these products can clear within your ${formatUsd(max)} max yet; watching for one.`,
    };
  }
  const lead = last
    ? `Your ${formatUsd(last.amountCents)} bid in ${bookName(last)} ${
        last.voidReason === 'LOST' ? 'lost when the brand cleared it' : 'closed without a sale'
      }, so I moved to ${bookName(best.book)}`
    : `I picked ${bookName(best.book)}`;
  return {
    kind: 'place',
    listingId: best.book.listingId,
    amountCents: best.amountCents,
    why: `${lead}: it needs the lowest bid relative to your ${formatUsd(max)} max${
      state.books.length > 1 ? ' and closes soonest among those' : ''
    }. Bid ${formatUsd(best.amountCents)}.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

export interface IntentRow {
  id: string;
  shopper_id: string;
  mandate_id: string | null;
  text: string | null;
  product_ids: string[];
  status: string;
  created_at: Date;
}

export type CreateIntentResult =
  | { ok: true; intent: IntentRow; mandate: MandateRow }
  | { ok: false; code: 'VALIDATION_ERROR'; field: string; message: string };

/**
 * `create_intent`: the intent and its mandate, **PAUSED** until the shopper confirms
 * (`activateIntent`). The mandate covers only the intent's products, one hold at a time
 * (cap = max), and leaves re-bidding to the move rule (`auto_roll = false`).
 */
export async function createIntent(
  q: Queryable,
  input: {
    shopperId: string;
    text: string;
    productIds: readonly string[];
    maxPriceCents: number;
    actor?: Actor;
  },
): Promise<CreateIntentResult> {
  const productIds = [...new Set(input.productIds)];
  if (!productIds.length || productIds.length > MAX_INTENT_PRODUCTS) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      field: 'productIds',
      message: `List 1 to ${MAX_INTENT_PRODUCTS} products.`,
    };
  }
  if (!productIds.every((id) => /^[0-9a-f-]{36}$/i.test(id))) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      field: 'productIds',
      message: 'Unknown product.',
    };
  }
  // Product ids come from our DB, never from free text (features/04 §Guardrails).
  const known = await q.query(
    `SELECT count(*)::int AS n FROM products WHERE id = ANY($1::uuid[])`,
    [productIds],
  );
  if ((known.rows[0] as { n: number }).n !== productIds.length) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      field: 'productIds',
      message: 'Unknown product.',
    };
  }
  const max = input.maxPriceCents;
  if (!Number.isInteger(max) || max < MIN_AMOUNT_CENTS || max > MAX_AMOUNT_CENTS) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      field: 'maxPriceCents',
      message: `The max must be whole cents between ${MIN_AMOUNT_CENTS} and ${MAX_AMOUNT_CENTS}.`,
    };
  }
  const actor = input.actor ?? { type: 'BUYER_AGENT', id: input.shopperId };
  const created = await createMandate(q, {
    shopperId: input.shopperId,
    maxPriceCents: max,
    totalHoldCapCents: max,
    allowedProductIds: productIds,
    autoRoll: false,
    actor,
  });
  const mandate = (await transition<'mandates', MandateRow>(
    q,
    'mandates',
    created.id,
    'ACTIVE',
    'PAUSED',
    {
      paused_at: SQL_NOW,
    },
  ))!;
  const res = await q.query(
    `INSERT INTO intents (shopper_id, mandate_id, text, product_ids)
     VALUES ($1, $2, $3, $4::uuid[]) RETURNING *`,
    [input.shopperId, mandate.id, input.text.slice(0, 500), productIds],
  );
  const intent = res.rows[0] as IntentRow;
  await audit(q, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    entity: 'intent',
    entityId: intent.id,
    action: 'INTENT_CREATED',
    data: { intentId: intent.id, mandateId: mandate.id, productIds, maxPriceCents: max },
  });
  return { ok: true, intent, mandate };
}

export async function findIntent(
  q: Queryable,
  shopperId: string,
  intentId: string,
): Promise<IntentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(intentId)) return null;
  const res = await q.query(`SELECT * FROM intents WHERE id = $1 AND shopper_id = $2`, [
    intentId,
    shopperId,
  ]);
  return (res.rows[0] as IntentRow | undefined) ?? null;
}

export type ActivateIntentResult =
  | { ok: true; intent: IntentRow; run: IntentRunResult | null }
  | { ok: false; code: 'NOT_FOUND' | 'STATE_CONFLICT'; message: string };

/**
 * The shopper confirmed `create_intent`: mandate PAUSED → ACTIVE, then the rule runs once with
 * the shopper present (customer-initiated hold).
 */
export async function activateIntent(
  deps: PlaceBidDeps,
  shopperId: string,
  intentId: string,
  actor: Actor = { type: 'BUYER_AGENT', id: shopperId },
): Promise<ActivateIntentResult> {
  const intent = await findIntent(deps.db.pool, shopperId, intentId);
  if (!intent || !intent.mandate_id)
    return { ok: false, code: 'NOT_FOUND', message: 'Unknown intent.' };
  if (intent.status !== 'OPEN') {
    return { ok: false, code: 'STATE_CONFLICT', message: `The intent is ${intent.status}.` };
  }
  await deps.db.tx(async (tx) => {
    const m = await transition<'mandates', MandateRow>(
      tx,
      'mandates',
      intent.mandate_id!,
      'PAUSED',
      'ACTIVE',
      {
        paused_at: null,
      },
    );
    if (m) {
      await audit(tx, {
        actorType: actor.type,
        actorId: actor.id ?? null,
        entity: 'mandate',
        entityId: m.id,
        action: 'MANDATE_ACTIVATED',
        data: { intentId },
      });
    }
  });
  const run = await runIntent(deps, intentId, { initiator: 'CUSTOMER', actor });
  return { ok: true, intent, run };
}

/** Everything `decideIntent` needs, read in one go (no locks: the money paths re-check). */
export async function loadIntentState(
  q: Queryable,
  intentId: string,
): Promise<{ intent: IntentRow; state: IntentState } | null> {
  const res = await q.query(
    `SELECT i.*, m.status AS mandate_status, m.max_price_cents, m.expires_at,
            clock_timestamp() AS db_now
       FROM intents i LEFT JOIN mandates m ON m.id = i.mandate_id
      WHERE i.id = $1`,
    [intentId],
  );
  const row = res.rows[0] as
    | (IntentRow & {
        mandate_status: string | null;
        max_price_cents: number | null;
        expires_at: Date | null;
        db_now: Date;
      })
    | undefined;
  if (!row) return null;

  const bids = await q.query(
    `SELECT b.id, b.listing_id, b.status, b.void_reason, b.amount_cents, b.placed_at, p.title
       FROM bids b JOIN listings l ON l.id = b.listing_id JOIN products p ON p.id = l.product_id
      WHERE b.intent_id = $1`,
    [intentId],
  );
  // Biddable books for the intent's products, skipping books where this shopper already has a
  // live bid outside the intent (D3). Amounts are the other shoppers' eligible bids (D8).
  const books = await q.query(
    `SELECT l.id, l.quantity, l.status, l.window_closes_at, l.rounds_end_at, p.title,
            br.name AS brand_name, p.best_public_price_cents,
            coalesce(array_agg(ob.amount_cents) FILTER (WHERE ob.id IS NOT NULL), '{}') AS others
       FROM listings l
       JOIN products p ON p.id = l.product_id
       JOIN brands br ON br.id = l.brand_id
       LEFT JOIN bids ob ON ob.listing_id = l.id AND ob.status = 'HELD'
                        AND ob.paypal_authorization_id IS NOT NULL AND ob.shopper_id <> $2
      WHERE l.product_id = ANY($1::uuid[]) AND l.status = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM bids mine
           WHERE mine.listing_id = l.id AND mine.shopper_id = $2
             AND mine.status IN ('PENDING_APPROVAL', 'HELD')
             AND mine.intent_id IS DISTINCT FROM $3)
      GROUP BY l.id, p.title, br.name, p.best_public_price_cents`,
    [row.product_ids, row.shopper_id, intentId],
  );
  const now = row.db_now;
  const mandateExpired = row.expires_at && new Date(row.expires_at).getTime() <= now.getTime();
  return {
    intent: row,
    state: {
      intentStatus: row.status,
      mandateStatus: mandateExpired ? 'EXPIRED' : row.mandate_status,
      maxCents: row.max_price_cents ?? 0,
      bids: (
        bids.rows as Array<{
          id: string;
          listing_id: string;
          status: string;
          void_reason: string | null;
          amount_cents: number;
          placed_at: Date;
          title: string | null;
        }>
      ).map((b) => ({
        id: b.id,
        listingId: b.listing_id,
        status: b.status,
        voidReason: b.void_reason,
        amountCents: b.amount_cents,
        placedAt: b.placed_at,
        title: b.title,
      })),
      books: (
        books.rows as Array<{
          id: string;
          quantity: number;
          status: string;
          window_closes_at: Date | null;
          rounds_end_at: Date | null;
          title: string | null;
          brand_name: string | null;
          best_public_price_cents: number | null;
          others: number[];
        }>
      )
        .filter(
          (l) =>
            !!l.window_closes_at &&
            isBiddable(
              { status: 'OPEN', windowClosesAt: l.window_closes_at, roundsEndAt: l.rounds_end_at },
              now,
            ),
        )
        .map((l) => ({
          listingId: l.id,
          title: l.title,
          brandName: l.brand_name,
          quantity: l.quantity,
          closesAt: l.window_closes_at!,
          otherAmountsCents: l.others.map(Number),
          bestPublicPriceCents: l.best_public_price_cents,
        })),
    },
  };
}

export type IntentRunResult =
  | {
      action: 'placed';
      decision: Extract<IntentDecision, { kind: 'place' }>;
      result: PlaceBidResult;
    }
  | { action: 'moved'; decision: Extract<IntentDecision, { kind: 'move' }>; result: MoveBidResult }
  | { action: 'none'; decision: IntentDecision };

/**
 * Run the move rule for one intent and act on it. Idempotency keys are derived from the intent
 * and its state, so two runners at once (the job and a confirm) make one placement / move; the
 * per-intent HELD index is the database backstop.
 */
export async function runIntent(
  deps: PlaceBidDeps,
  intentId: string,
  opts: { initiator?: 'CUSTOMER' | 'MERCHANT'; actor?: Actor } = {},
): Promise<IntentRunResult | null> {
  const loaded = await loadIntentState(deps.db.pool, intentId);
  if (!loaded) return null;
  const { intent, state } = loaded;
  const decision = decideIntent(state);
  const actor = opts.actor ?? { type: 'BUYER_AGENT', id: intent.shopper_id };
  const initiator = opts.initiator ?? 'MERCHANT';

  if (decision.kind === 'place') {
    const result = await placeBid(deps, {
      shopperId: intent.shopper_id,
      listingId: decision.listingId,
      amountCents: decision.amountCents,
      paymentMethod: 'VAULT',
      mandateId: intent.mandate_id,
      intentId,
      source: 'BUYER_AGENT',
      initiator,
      idempotencyKey: `intent:${intentId}:place:${state.bids.length}`,
      actor,
    });
    if (result.ok && !result.replayed) {
      await audit(deps.db.pool, {
        actorType: actor.type,
        actorId: actor.id ?? null,
        listingId: result.bid.listing_id,
        entity: 'bid',
        entityId: result.bid.id,
        action: INTENT_PLACED_ACTION,
        requestId: result.bid.id,
        data: {
          intentId,
          toListingId: decision.listingId,
          newCents: decision.amountCents,
          why: decision.why,
        },
      });
    }
    return { action: 'placed', decision, result };
  }
  if (decision.kind === 'move') {
    const result = await moveBid(deps, {
      bidId: decision.bidId,
      toListingId: decision.toListingId,
      amountCents: decision.amountCents,
      shopperId: intent.shopper_id,
      // One key per attempt: a failed move inserted a bid of the intent, so the next run (another
      // book, another amount, or a retry) gets a fresh key instead of replaying the failure.
      idempotencyKey: `intent:${intentId}:move:${decision.bidId}:${state.bids.length}`,
      reason: 'BETTER_BOOK',
      why: decision.why,
      actor,
      initiator,
    });
    return { action: 'moved', decision, result };
  }
  return { action: 'none', decision };
}

/**
 * The `intent-move-rule` job: every OPEN intent under an ACTIVE mandate, one at a time. Shoppers
 * with no saved payment method are skipped (the rule's holds are merchant-initiated VAULT holds).
 */
export async function runOpenIntents(
  deps: PlaceBidDeps,
  opts: { limit?: number; onError?: (err: unknown, intentId: string) => void } = {},
): Promise<{ checked: number; placed: number; moved: number }> {
  const res = await deps.db.pool.query(
    `SELECT i.id FROM intents i JOIN mandates m ON m.id = i.mandate_id
       JOIN shoppers s ON s.id = i.shopper_id
      WHERE i.status = 'OPEN' AND m.status = 'ACTIVE' AND s.paypal_vault_id IS NOT NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
      ORDER BY i.created_at LIMIT $1`,
    [opts.limit ?? 200],
  );
  const out = { checked: 0, placed: 0, moved: 0 };
  for (const { id } of res.rows as { id: string }[]) {
    out.checked++;
    try {
      const r = await runIntent(deps, id);
      if (r?.action === 'placed' && r.result.ok) out.placed++;
      if (r?.action === 'moved' && r.result.ok) out.moved++;
    } catch (err) {
      opts.onError?.(err, id);
    }
  }
  return out;
}

export interface IntentView {
  intentId: string;
  text: string | null;
  status: string;
  mandateStatus: string | null;
  maxPriceCents: number | null;
  products: Array<{ productId: string; title: string | null }>;
  liveBid: { bidId: string; listingId: string; amountCents: number; status: string } | null;
  /** Placements and moves, oldest first, with the reason the rule recorded. */
  history: Array<{
    at: string;
    kind: 'PLACED' | 'MOVED';
    bidId: string;
    fromListingId: string | null;
    toListingId: string | null;
    amountCents: number | null;
    previousAmountCents: number | null;
    reason: string | null;
    why: string | null;
  }>;
  /** What the rule would do now, in words ("why hasn't it moved?"). */
  now: string;
}

/** The shopper's intents with their move history (the agent's `my_intents`). */
export async function listIntents(q: Queryable, shopperId: string): Promise<IntentView[]> {
  const res = await q.query(
    `SELECT i.id FROM intents i WHERE i.shopper_id = $1 ORDER BY i.created_at DESC LIMIT 10`,
    [shopperId],
  );
  const out: IntentView[] = [];
  for (const { id } of res.rows as { id: string }[]) {
    const loaded = await loadIntentState(q, id);
    if (!loaded) continue;
    const { intent, state } = loaded;
    const products = await q.query(`SELECT id, title FROM products WHERE id = ANY($1::uuid[])`, [
      intent.product_ids,
    ]);
    const events = await q.query(
      `SELECT at, action, entity_id, data FROM audit_events
        WHERE action = ANY($1::text[]) AND data->>'intentId' = $2
        ORDER BY at, id`,
      [[MOVED_ACTION, INTENT_PLACED_ACTION], id],
    );
    const live = state.bids.find((b) => b.status === 'HELD' || b.status === 'PENDING_APPROVAL');
    out.push({
      intentId: id,
      text: intent.text,
      status: intent.status,
      mandateStatus: state.mandateStatus,
      maxPriceCents: state.maxCents || null,
      products: (products.rows as Array<{ id: string; title: string | null }>).map((p) => ({
        productId: p.id,
        title: p.title,
      })),
      liveBid: live
        ? {
            bidId: live.id,
            listingId: live.listingId,
            amountCents: live.amountCents,
            status: live.status,
          }
        : null,
      history: (
        events.rows as Array<{
          at: Date;
          action: string;
          entity_id: string;
          data: Record<string, unknown>;
        }>
      ).map((e) => ({
        at: new Date(e.at).toISOString(),
        kind: e.action === MOVED_ACTION ? 'MOVED' : 'PLACED',
        bidId: e.entity_id,
        fromListingId: (e.data.fromListingId as string | undefined) ?? null,
        toListingId: (e.data.toListingId as string | undefined) ?? null,
        amountCents: (e.data.newCents as number | undefined) ?? null,
        previousAmountCents: (e.data.oldCents as number | undefined) ?? null,
        reason: (e.data.reason as string | undefined) ?? null,
        why:
          (e.data.why as string | undefined) ??
          (e.data.reason === 'SHOPPER' ? 'You confirmed this move.' : null),
      })),
      now: decideIntent(state).why,
    });
  }
  return out;
}
