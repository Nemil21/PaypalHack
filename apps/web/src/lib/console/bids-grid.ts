import {
  formatUsd,
  moneyCopyKey,
  type BidSource,
  type BookBid,
  type BookResponse,
  type MoneyCopyKey,
} from '@holdfast/shared';

/**
 * The console bids grid's row model (HF-025, features/08 §Layout 5). No React or AG Grid here:
 * the grid component feeds it every book snapshot and applies the deltas it returns with
 * `applyTransactionAsync`, so rows are inserted, updated and removed in place (never a full
 * `rowData` reset, which would kill the flash and the user's scroll).
 *
 * Rows are the Clear input only (`book.bids`, HELD with a real hold). No-hold bids never reach
 * this grid (D8), and a bid leaves it the moment its void starts (VOIDING).
 *
 * **Raises keep their row.** A raise is a new bid that replaces the old one (HF-018), so the new
 * bid id is unknown to the grid. The row keeps the id of the first bid in its raise chain as its
 * grid row id (`getRowId`), and the new bid is matched to it:
 *
 * 1. by the `bid.raised` notice (`ids.bidId` replaces `ids.replacesBidId`), when it arrives
 *    before the book that carries the new bid (the usual order: the notice triggers the refetch);
 * 2. else by the shopper label: labels are per shopper and stable on a listing, and a shopper has
 *    one live bid (D1), so a label that leaves and comes back in the same snapshot is the same
 *    shopper's replacement bid. This covers a notice missed during a reconnect.
 */

/** How long a raised row shows "$219 → $241" before going back to the plain amount. */
export const RAISE_FLASH_MS = 4_000;

/** Aliases kept for raises whose new bid has not shown up in a book yet. */
const MAX_PENDING_ALIASES = 500;

export interface BidRow {
  /** Grid row id: the first bid id of this shopper's raise chain on the grid. */
  rowId: string;
  /** The live bid behind the row now. */
  bidId: string;
  amountCents: number;
  /** Server rank (1-based); null below the floor. */
  rank: number | null;
  belowFloor: boolean;
  /** `placed_at` in epoch ms (the book sends µs as a string). */
  placedAtMs: number;
  source: BidSource | null;
  isSimulated: boolean;
  shopperLabel: string;
  /** Money copy (screens.md): held before capture, charged after, releasing/released for voids. */
  status: MoneyCopyKey;
  /** The previous amount while the raise flash shows; null otherwise. */
  raisedFromCents: number | null;
  /** When the raise flash ends (epoch ms); null when not raised recently. */
  raisedUntil: number | null;
}

export interface RowDelta {
  add: BidRow[];
  update: BidRow[];
  remove: BidRow[];
  /** Row ids raised in this snapshot (a subset of `update`), for the row flash. */
  raised: string[];
}

export interface BidRowTracker {
  /** A `bid.raised` notice: `newBidId` replaces `oldBidId`. */
  noteRaise(newBidId: string, oldBidId: string): void;
  /** Diff a new book snapshot against the rows the grid holds. */
  apply(book: BookResponse, now: number): RowDelta;
  /** Rows whose raise flash has ended by `now`, with it cleared (apply as updates). */
  expireRaises(now: number): BidRow[];
  /** Earliest pending raise-flash end, or null. */
  nextRaiseExpiry(): number | null;
  /** Current rows (unordered). */
  rows(): BidRow[];
  /** Forget the rows (a new grid mounted); pending raise aliases are kept. */
  reset(): void;
}

const SOURCES: readonly string[] = ['OFFER_PAGE', 'BUYER_AGENT', 'MCP', 'SIM'];

function sourceOf(s: string | null): BidSource | null {
  return s !== null && SOURCES.includes(s) ? (s as BidSource) : null;
}

const SOURCE_LABEL: Record<BidSource, string> = {
  OFFER_PAGE: 'Offer page',
  BUYER_AGENT: 'Agent',
  MCP: 'MCP',
  SIM: 'SIM',
};

/** "Offer page" / "Agent" / "MCP" / "SIM" (features/08 §Layout 5). */
export function sourceLabel(source: BidSource | null): string {
  return source ? SOURCE_LABEL[source] : 'Other';
}

const STATUS_LABEL: Record<MoneyCopyKey, string> = {
  held: 'Held',
  releasing: 'Releasing',
  released: 'Released',
  charged: 'Charged',
  none: 'No hold',
};

export function statusLabel(status: MoneyCopyKey): string {
  return STATUS_LABEL[status];
}

/** The Rank cell: the server rank, or "below floor" (brand-only). */
export function rankLabel(row: Pick<BidRow, 'rank' | 'belowFloor'>): string {
  if (row.rank !== null) return String(row.rank);
  return row.belowFloor ? 'below floor' : '—';
}

/** The Bid cell: "$241", or "$219 → $241" while a raise flash shows. */
export function amountLabel(row: Pick<BidRow, 'amountCents' | 'raisedFromCents'>): string {
  const now = formatUsd(row.amountCents);
  return row.raisedFromCents === null ? now : `${formatUsd(row.raisedFromCents)} → ${now}`;
}

/** Rank sort: ranked bids by rank, then below-floor bids by amount (high first). */
export function compareRank(
  a: Pick<BidRow, 'rank' | 'amountCents'>,
  b: Pick<BidRow, 'rank' | 'amountCents'>,
): number {
  if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
  if (a.rank !== null) return -1;
  if (b.rank !== null) return 1;
  return b.amountCents - a.amountCents;
}

export interface SourceSummary {
  source: BidSource | null;
  label: string;
  count: number;
  heldCents: number;
  simulated: number;
}

/** Bids and held dollars per source, largest held first (the grid's source strip). */
export function heldBySource(rows: readonly BidRow[]): SourceSummary[] {
  const by = new Map<BidSource | null, SourceSummary>();
  for (const r of rows) {
    const s = by.get(r.source) ?? {
      source: r.source,
      label: sourceLabel(r.source),
      count: 0,
      heldCents: 0,
      simulated: 0,
    };
    s.count++;
    s.heldCents += r.amountCents;
    if (r.isSimulated) s.simulated++;
    by.set(r.source, s);
  }
  return [...by.values()].sort(
    (a, b) => b.heldCents - a.heldCents || a.label.localeCompare(b.label),
  );
}

function placedMs(us: string): number {
  // µs since epoch: drop the last 3 digits for ms without going through a lossy float.
  return us.length > 3 ? Number(us.slice(0, -3)) : 0;
}

function sameRow(a: BidRow, b: BidRow): boolean {
  return (
    a.bidId === b.bidId &&
    a.amountCents === b.amountCents &&
    a.rank === b.rank &&
    a.belowFloor === b.belowFloor &&
    a.placedAtMs === b.placedAtMs &&
    a.source === b.source &&
    a.isSimulated === b.isSimulated &&
    a.shopperLabel === b.shopperLabel &&
    a.status === b.status &&
    a.raisedFromCents === b.raisedFromCents &&
    a.raisedUntil === b.raisedUntil
  );
}

export function createBidRowTracker(): BidRowTracker {
  /** rowId → row. */
  let rows = new Map<string, BidRow>();
  /** live bid id → rowId. */
  let rowOfBid = new Map<string, string>();
  /** new bid id → the bid it replaces (from `bid.raised` notices), insertion-ordered. */
  const replaces = new Map<string, string>();

  /** Follow `replaces` back to a bid the grid has a row for. */
  const rowViaAlias = (bidId: string): string | undefined => {
    let id: string | undefined = bidId;
    for (let hops = 0; id !== undefined && hops < 32; hops++) {
      const rowId = rowOfBid.get(id);
      if (rowId !== undefined && id !== bidId) return rowId;
      id = replaces.get(id);
    }
    return undefined;
  };

  return {
    noteRaise(newBidId, oldBidId) {
      if (newBidId === oldBidId) return;
      replaces.set(newBidId, oldBidId);
      while (replaces.size > MAX_PENDING_ALIASES) {
        replaces.delete(replaces.keys().next().value!);
      }
    },

    apply(book, now) {
      const nextIds = new Set(book.bids.map((b) => b.id));
      const claimed = new Set<string>();
      const nextRows = new Map<string, BidRow>();
      const add: BidRow[] = [];
      const update: BidRow[] = [];
      const raised: string[] = [];

      // Rows whose bid left the book, by shopper label: candidates for the label fallback.
      const leftByLabel = new Map<string, BidRow>();
      for (const r of rows.values()) {
        if (!nextIds.has(r.bidId)) leftByLabel.set(r.shopperLabel, r);
      }

      const claim = (b: BookBid): string | undefined => {
        const own = rowOfBid.get(b.id);
        if (own !== undefined && !claimed.has(own)) return own;
        const viaAlias = rowViaAlias(b.id);
        if (viaAlias !== undefined && !claimed.has(viaAlias)) return viaAlias;
        const viaLabel = leftByLabel.get(b.shopperLabel);
        if (viaLabel && !claimed.has(viaLabel.rowId)) return viaLabel.rowId;
        return undefined;
      };

      for (const b of book.bids) {
        const rowId = claim(b);
        const prev = rowId === undefined ? undefined : rows.get(rowId);
        const isRaise =
          prev !== undefined && prev.bidId !== b.id && b.amountCents > prev.amountCents;
        const row: BidRow = {
          rowId: rowId ?? b.id,
          bidId: b.id,
          amountCents: b.amountCents,
          rank: b.rank,
          belowFloor: b.belowFloor,
          placedAtMs: placedMs(b.placedAtUs),
          source: sourceOf(b.source),
          isSimulated: b.isSimulated,
          shopperLabel: b.shopperLabel,
          status: moneyCopyKey(b.status),
          raisedFromCents: isRaise
            ? prev.amountCents
            : prev && prev.raisedUntil !== null && prev.raisedUntil > now
              ? prev.raisedFromCents
              : null,
          raisedUntil: isRaise
            ? now + RAISE_FLASH_MS
            : prev && prev.raisedUntil !== null && prev.raisedUntil > now
              ? prev.raisedUntil
              : null,
        };
        claimed.add(row.rowId);
        nextRows.set(row.rowId, row);
        if (!prev) add.push(row);
        else if (!sameRow(prev, row)) update.push(row);
        if (isRaise) raised.push(row.rowId);
        if (prev && prev.bidId !== b.id) replaces.delete(b.id);
      }

      const remove = [...rows.values()].filter((r) => !nextRows.has(r.rowId));
      rows = nextRows;
      rowOfBid = new Map([...nextRows.values()].map((r) => [r.bidId, r.rowId]));
      return { add, update, remove, raised };
    },

    expireRaises(now) {
      const done: BidRow[] = [];
      for (const r of rows.values()) {
        if (r.raisedUntil !== null && r.raisedUntil <= now) {
          const cleared = { ...r, raisedFromCents: null, raisedUntil: null };
          rows.set(r.rowId, cleared);
          done.push(cleared);
        }
      }
      return done;
    },

    nextRaiseExpiry() {
      let next: number | null = null;
      for (const r of rows.values()) {
        if (r.raisedUntil !== null && (next === null || r.raisedUntil < next)) next = r.raisedUntil;
      }
      return next;
    },

    rows: () => [...rows.values()],

    reset() {
      rows = new Map();
      rowOfBid = new Map();
    },
  };
}

/** Timer seam for `armRaiseExpiry`, so tests can drive it with fake timers. */
export interface ExpiryClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: ExpiryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Clear each raise flash when it ends: one timer at the earliest `raisedUntil`, re-armed after
 * every expiry, so staggered raises each clear on time even when no new book arrives.
 * `onExpired` gets the cleared rows (apply them as updates). Returns a cancel function.
 */
export function armRaiseExpiry(
  tracker: BidRowTracker,
  onExpired: (rows: BidRow[]) => void,
  clock: ExpiryClock = realClock,
): () => void {
  let timer: unknown = null;
  let cancelled = false;
  const arm = () => {
    timer = null;
    const at = tracker.nextRaiseExpiry();
    if (at === null || cancelled) return;
    timer = clock.setTimeout(
      () => {
        if (cancelled) return;
        const done = tracker.expireRaises(clock.now());
        if (done.length) onExpired(done);
        arm();
      },
      Math.max(0, at - clock.now()) + 20,
    );
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== null) clock.clearTimeout(timer);
  };
}
