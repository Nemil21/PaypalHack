import { decimalToCents, formatUsd, MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS } from '@holdfast/shared';

/**
 * Offer page logic (W12 / M01, HF-019) with no React in it, so it is unit-tested. The page
 * (routes/OfferPage.tsx) renders what these return.
 */

/** `GET /api/offers/:slug` (api.md; packages/core/src/offers/offer.ts). Never carries the floor. */
export interface OfferView {
  listingId: string;
  slug: string;
  brand: { name: string; verified: boolean };
  product: { title: string | null; imageUrl: string | null; bestPublicPriceCents: number | null };
  publicOffer: {
    merchant: string | null;
    priceCents: number;
    url: string | null;
    updatedAt: string | null;
  } | null;
  /** HF-042b: Channel3 unreachable; show "Public price check paused". Absent on older APIs. */
  priceWatchPaused?: boolean;
  status: string;
  phase: string;
  biddable: boolean;
  windowClosesAt: string | null;
  roundsEndAt: string | null;
  suggestedBidCents: number | null;
  likelyBand: { fromCents: number; toCents: number } | null;
  myBid: {
    bidId: string;
    status: 'PENDING_APPROVAL' | 'HELD';
    amountCents: number;
    paymentMethod: string | null;
    releaseIfCheaper: boolean;
    placedAt: string;
  } | null;
}

/** What the "Hold" button pays with. VAULT is for agents and raises, not this page. */
export type OfferPaymentMethod = 'PAYPAL' | 'CARD' | 'TEST_CARD';

/** M01: the big ± stepper moves in $5 steps. */
export const STEP_CENTS = 500;

export function clampAmount(cents: number): number {
  return Math.min(MAX_AMOUNT_CENTS, Math.max(MIN_AMOUNT_CENTS, Math.round(cents)));
}

export function stepAmount(cents: number, direction: 1 | -1): number {
  return clampAmount(cents + direction * STEP_CENTS);
}

/** Typed price ("229", "$229.50", "1,029") → cents, or null when it isn't a valid amount. */
export function parseDollarInput(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  try {
    const cents = decimalToCents(cleaned);
    return cents >= MIN_AMOUNT_CENTS && cents <= MAX_AMOUNT_CENTS ? cents : null;
  } catch {
    return null;
  }
}

/** Cents → the input's text: "229" or "229.50". */
export function dollarsText(cents: number): string {
  return formatUsd(cents).replace(/^\$/, '').replace(/,/g, '');
}

/** `?amount=22900` deep link (HF-039, HF-044a): integer cents within the bid limits, else null. */
export function parseAmountParam(raw: string | null): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const cents = Number(raw);
  return cents >= MIN_AMOUNT_CENTS && cents <= MAX_AMOUNT_CENTS ? cents : null;
}

/** `?src=agent|mcp` → `utmSource` attribution on the bid (the server sets `source` itself). */
export function parseSourceParam(raw: string | null): string | null {
  return raw && /^[a-z0-9_-]{1,32}$/i.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Attribution (HF-055): `?utm_source=` from a share link or the widget (`utm_medium=widget`),
 * else `?src=agent|mcp`. The source goes into `POST /bids` as `utmSource`.
 */
export function attributionOf(params: URLSearchParams): {
  source: string | null;
  medium: string | null;
} {
  return {
    source: parseSourceParam(params.get('utm_source')) ?? parseSourceParam(params.get('src')),
    medium: parseSourceParam(params.get('utm_medium')),
  };
}

/**
 * Whether this tab should log a click for `slug` + `source` (`POST /api/offers/:slug/clicks`),
 * marking it done: a reload, or coming back from PayPal, is the same visit. Storage that throws
 * (private mode, blocked) still logs once per page load.
 */
export function claimClick(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  slug: string,
  source: string,
): boolean {
  const key = `hf-click:${slug}:${source}`;
  try {
    if (!storage || storage.getItem(key)) return !storage;
    storage.setItem(key, '1');
    return true;
  } catch {
    return true;
  }
}

/** Starting price: the deep link, else the ~18%-below-public suggestion, else the band. */
export function initialAmount(offer: OfferView, amountParam: number | null): number {
  return (
    amountParam ??
    offer.suggestedBidCents ??
    offer.likelyBand?.fromCents ??
    offer.myBid?.amountCents ??
    10_000
  );
}

/** Slider range: half the public price up to 10% over it (rounded to $10); typed input is free. */
export function sliderRange(offer: OfferView, amount: number): { min: number; max: number } {
  const anchor = offer.publicOffer?.priceCents ?? offer.suggestedBidCents ?? amount;
  const min = clampAmount(Math.floor((anchor * 0.5) / 1000) * 1000);
  const max = clampAmount(Math.ceil((anchor * 1.1) / 1000) * 1000);
  return { min: Math.min(min, amount), max: Math.max(max, amount) };
}

/**
 * Over the public price: the shopper may still bid (features/03 edge cases), after this warning.
 * Confirming it sends `releaseIfCheaper=false`.
 */
export function overPublicWarning(
  amountCents: number,
  publicOffer: OfferView['publicOffer'],
): string | null {
  if (!publicOffer || amountCents <= publicOffer.priceCents) return null;
  return `Another store sells it for ${formatUsd(publicOffer.priceCents)} today. Still bid ${formatUsd(amountCents)}?`;
}

export const NO_RELEASE_COPY = "We won't release this bid for a cheaper store.";

export function holdLabel(method: OfferPaymentMethod, amountCents: number): string {
  const amount = formatUsd(amountCents);
  switch (method) {
    case 'PAYPAL':
      return `Hold ${amount} with PayPal`;
    case 'CARD':
      return `Hold ${amount} with card`;
    case 'TEST_CARD':
      return `Hold ${amount} with sandbox test card`;
  }
}

/** "Cheapest public price $279 at retailer.example". */
export function anchorText(offer: OfferView): string | null {
  const p = offer.publicOffer;
  if (!p) return null;
  return p.merchant
    ? `Cheapest public price ${formatUsd(p.priceCents)} at ${p.merchant}`
    : `Cheapest public price ${formatUsd(p.priceCents)}`;
}

/** Floor-blind hint (M22) or, with no band, the suggestion only. */
export function priceHint(offer: OfferView): string | null {
  const b = offer.likelyBand;
  if (b) {
    return `Bids between ${formatUsd(b.fromCents)} and ${formatUsd(b.toCents)} are most likely to clear.`;
  }
  if (offer.suggestedBidCents != null && offer.publicOffer) {
    return `We suggest ${formatUsd(offer.suggestedBidCents)}, about 18% below the cheapest public price.`;
  }
  return null;
}

/** Countdown text: "1d 04h 12m", "4h 12m 05s", "12m 05s"; null once it has passed. */
export function countdownText(msLeft: number): string | null {
  if (msLeft <= 0) return null;
  const s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  return `${m}m ${pad(sec)}s`;
}

/** Smallest raise (features/05): $1 or 1%, whichever is more. */
export function minRaiseCents(currentCents: number): number {
  return clampAmount(currentCents + Math.max(100, Math.ceil(currentCents / 100)));
}

/** What the page shows for an offer: the form, "already bid", or a closed state. */
export type OfferMode = 'bid' | 'already_bid' | 'rounds' | 'closed';

export function offerMode(offer: OfferView): OfferMode {
  if (offer.myBid) return 'already_bid';
  if (offer.biddable) return 'bid';
  if (offer.status === 'ROUNDS') return 'rounds';
  return 'closed';
}

/** How the page reacts to a failed hold attempt. */
export type HoldFailure =
  | { kind: 'already_bid' }
  | { kind: 'closed'; text: string }
  | { kind: 'declined'; text: string }
  | { kind: 'session'; text: string }
  | { kind: 'retry'; text: string }
  | { kind: 'message'; text: string };

export function holdFailure(
  err: { status: number; code: string; message: string },
  amountCents: number,
): HoldFailure {
  switch (err.code) {
    case 'ALREADY_BID':
      return { kind: 'already_bid' };
    case 'WINDOW_CLOSED':
      return { kind: 'closed', text: err.message || 'This window has closed.' };
    case 'HOLD_FAILED':
      return {
        kind: 'declined',
        text: `PayPal couldn't hold ${formatUsd(amountCents)}. Try another payment method.`,
      };
    case 'UNAUTHENTICATED':
      return { kind: 'session', text: 'Your session expired. We started a new one; try again.' };
    case 'IN_PROGRESS':
      return { kind: 'retry', text: 'Your hold is still being placed. Try again in a moment.' };
  }
  if (err.status === 0 || err.status === 429 || err.status >= 500) {
    return { kind: 'retry', text: err.message || 'Something went wrong. Try again.' };
  }
  return { kind: 'message', text: err.message || 'This bid could not be placed.' };
}
