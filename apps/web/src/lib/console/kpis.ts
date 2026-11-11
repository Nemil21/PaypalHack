import {
  clear,
  clearBidsFromBook,
  formatUsd,
  liquidationCents,
  recoveryMultiple,
  type BookResponse,
} from '@holdfast/shared';
import type { SliderNumbers } from './slider';

/**
 * The console KPI row (HF-023, features/08 §Layout 2), derived from one `GET /book` snapshot with
 * the shared `clear()`, so "Projected cutoff" matches the server's `/simulate` and Clear. The
 * console feeds it the slider's numbers (`consoleKpisAt`, HF-024).
 */
export interface ConsoleKpis {
  heldCents: number;
  /** The SIM part of `heldCents`, for the "incl. $X simulated" hover. */
  simulatedHeldCents: number;
  liveBids: number;
  quantity: number;
  cutoffCents: number | null;
  grossCents: number;
  winners: number;
  recoveryMultiple: number | null;
  /** The listing has a liquidation quote to compare against. */
  hasLiquidationQuote: boolean;
  releasedByPriceWatch: number;
}

export function consoleKpis(book: BookResponse, quantity?: number): ConsoleKpis {
  const q = Math.max(1, Math.min(quantity ?? book.listing.quantity, book.listing.quantity));
  const result = clear(clearBidsFromBook(book.bids), q, book.listing.floorCents);
  const winners = result.winners.length;
  return consoleKpisAt(book, {
    quantity: q,
    cutoffCents: result.cutoffCents,
    grossCents: result.grossCents,
    winners,
    recoveryMultiple: recoveryMultiple(
      result.grossCents,
      liquidationCents(winners, book.listing.liquidationQuoteCents),
    ),
  });
}

/**
 * The KPI row at the slider's numbers (HF-024: prefix sums while dragging, the shared `clear()` on
 * release). `null` numbers (no bid at or above the floor) project nothing at the listing quantity.
 */
export function consoleKpisAt(
  book: BookResponse,
  at: Pick<
    SliderNumbers,
    'quantity' | 'cutoffCents' | 'grossCents' | 'winners' | 'recoveryMultiple'
  > | null,
): ConsoleKpis {
  return {
    heldCents: book.stats.heldCents,
    simulatedHeldCents: book.stats.simulatedHeldCents,
    liveBids: book.stats.liveBids,
    quantity: at?.quantity ?? book.listing.quantity,
    cutoffCents: at?.cutoffCents ?? null,
    grossCents: at?.grossCents ?? 0,
    winners: at?.winners ?? 0,
    recoveryMultiple: at?.recoveryMultiple ?? null,
    hasLiquidationQuote: book.listing.liquidationQuoteCents !== null,
    releasedByPriceWatch: book.stats.releasedByPriceWatch,
  };
}

/** "$61.2k" for KPI tiles; exact `formatUsd` below $10k. */
export function formatUsdCompact(cents: number): string {
  if (Math.abs(cents) < 1_000_000) return formatUsd(cents);
  const dollars = cents / 100;
  if (Math.abs(dollars) < 1_000_000) return `$${trim(dollars / 1000)}k`;
  return `$${trim(dollars / 1_000_000)}M`;
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/** "incl. $1,240 simulated" (hover on Held demand); null when nothing is simulated. */
export function simulatedNote(k: Pick<ConsoleKpis, 'simulatedHeldCents'>): string | null {
  return k.simulatedHeldCents > 0 ? `incl. ${formatUsd(k.simulatedHeldCents)} simulated` : null;
}

/**
 * The price-drop toast (`pricewatch.released`). The SSE notice carries ids only (HF-008), so the
 * count and price come from the refetched book: how many more bids price watch released, and
 * the new public low. "3 bids released: public price dropped to $219".
 */
export function priceDropToast(
  before: BookResponse | null,
  after: BookResponse,
): { title: string; body?: string } | null {
  const count = after.stats.releasedByPriceWatch - (before ? before.stats.releasedByPriceWatch : 0);
  if (count <= 0) return null;
  const price = after.listing.priceWatch.bestPublicPriceCents;
  const merchant = after.listing.priceWatch.merchant;
  const what = `${count} ${count === 1 ? 'bid' : 'bids'} released`;
  return {
    title: price === null ? what : `${what}: public price dropped to ${formatUsd(price)}`,
    body: merchant
      ? `New public low at ${merchant}. Those shoppers' holds are released.`
      : undefined,
  };
}
