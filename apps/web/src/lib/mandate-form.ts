import {
  formatUsd,
  MANDATE_DEFAULT_DAYS,
  MAX_AMOUNT_CENTS,
  MIN_AMOUNT_CENTS,
  type CreateMandateRequest,
  type MandateView,
  type UpdateMandateRequest,
} from '@holdfast/shared';

/**
 * W17 / M09 mandate form logic (HF-017b), kept free of React so it is unit-tested. Amounts are
 * typed in dollars and sent as integer cents; the expiry is a date input (`yyyy-mm-dd`) sent as
 * the end of that local day.
 */

export interface MandateFormValues {
  /** Dollars as typed, e.g. "230" or "229.50". */
  maxPrice: string;
  totalCap: string;
  productIds: string[];
  /** `yyyy-mm-dd` (date input). */
  expiresOn: string;
  autoRoll: boolean;
  notifyEveryAction: boolean;
}

export type MandateFormField = 'maxPrice' | 'totalCap' | 'expiresOn' | 'productIds';
export type MandateFormErrors = Partial<Record<MandateFormField, string>>;

/** Prefill from W13 "Let my agent manage this" (`/mandates/new?productId=…&maxPriceCents=…`). */
export interface MandatePrefill {
  productId?: string;
  maxPriceCents?: number;
}

const DOLLARS = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "229", "$229.5", "1,250.00" → cents; anything else → null. */
export function parseDollars(input: string): number | null {
  const m = DOLLARS.exec(input.trim());
  if (!m) return null;
  const whole = Number(m[1]!.replaceAll(',', ''));
  const frac = Number((m[2] ?? '').padEnd(2, '0') || '0');
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Cents → the input's text: 23000 → "230", 22950 → "229.50". */
export function formatDollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

/** Stepper: add `deltaCents` (±$1, ±$10 …), clamped to the allowed amount range. */
export function stepDollars(input: string, deltaCents: number): string {
  const cents = parseDollars(input) ?? 0;
  const next = Math.min(MAX_AMOUNT_CENTS, Math.max(MIN_AMOUNT_CENTS, cents + deltaCents));
  return formatDollars(next);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO instant → `yyyy-mm-dd` in local time (date input value). */
export function dateInputValue(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `yyyy-mm-dd` → the end of that local day as ISO; null when malformed. */
export function expiryIso(dateInput: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateInput);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
  return Number.isNaN(d.getTime()) || dateInputValue(d) !== dateInput ? null : d.toISOString();
}

/** `?productId=…&maxPriceCents=…`, ignoring malformed values. */
export function readPrefill(params: URLSearchParams): MandatePrefill {
  const out: MandatePrefill = {};
  const productId = params.get('productId');
  if (productId && UUID.test(productId)) out.productId = productId;
  const max = Number(params.get('maxPriceCents'));
  if (Number.isInteger(max) && max >= MIN_AMOUNT_CENTS && max <= MAX_AMOUNT_CENTS) {
    out.maxPriceCents = max;
  }
  return out;
}

/** A new mandate: cap = max price, 30 days, auto-roll and notify on (05 §Logic 1). */
export function newMandateForm(prefill: MandatePrefill = {}, now = new Date()): MandateFormValues {
  const max = prefill.maxPriceCents ? formatDollars(prefill.maxPriceCents) : '';
  return {
    maxPrice: max,
    totalCap: max,
    productIds: prefill.productId ? [prefill.productId] : [],
    expiresOn: dateInputValue(new Date(now.getTime() + MANDATE_DEFAULT_DAYS * DAY_MS)),
    autoRoll: true,
    notifyEveryAction: true,
  };
}

export function formFromMandate(m: MandateView): MandateFormValues {
  return {
    maxPrice: formatDollars(m.maxPriceCents),
    totalCap: formatDollars(m.totalHoldCapCents),
    productIds: [...m.productIds],
    expiresOn: m.expiresAt ? dateInputValue(m.expiresAt) : '',
    autoRoll: m.autoRoll,
    notifyEveryAction: m.notifyEveryAction,
  };
}

/** The message shown (and sent by the API) when the cap is set below the live holds. */
export function capBelowLiveMessage(liveHoldCents: number): string {
  const live = formatUsd(liveHoldCents);
  return `Your live holds under this mandate total ${live}. Set a total cap of at least ${live}, or release a hold first.`;
}

export function validateMandateForm(
  v: MandateFormValues,
  { liveHoldCents = 0, now = new Date() }: { liveHoldCents?: number; now?: Date } = {},
): MandateFormErrors {
  const errors: MandateFormErrors = {};
  const range = `Enter an amount between ${formatUsd(MIN_AMOUNT_CENTS)} and ${formatUsd(MAX_AMOUNT_CENTS)}.`;
  const max = parseDollars(v.maxPrice);
  const cap = parseDollars(v.totalCap);
  if (max === null || max < MIN_AMOUNT_CENTS || max > MAX_AMOUNT_CENTS) errors.maxPrice = range;
  if (cap === null || cap < MIN_AMOUNT_CENTS || cap > MAX_AMOUNT_CENTS) errors.totalCap = range;
  else if (max !== null && !errors.maxPrice && cap < max) {
    errors.totalCap = `The total cap must be at least your max price (${formatUsd(max)}).`;
  } else if (cap < liveHoldCents) {
    errors.totalCap = capBelowLiveMessage(liveHoldCents);
  }
  const expiry = expiryIso(v.expiresOn);
  if (!expiry) errors.expiresOn = 'Pick an end date.';
  else if (Date.parse(expiry) <= now.getTime())
    errors.expiresOn = 'Pick an end date in the future.';
  if (v.productIds.length > 25) errors.productIds = 'Pick at most 25 products.';
  return errors;
}

/** `POST /api/mandates` body. Call after `validateMandateForm` returned no errors. */
export function createRequest(v: MandateFormValues): CreateMandateRequest {
  return {
    maxPriceCents: parseDollars(v.maxPrice)!,
    totalHoldCapCents: parseDollars(v.totalCap)!,
    productIds: [...v.productIds],
    autoRoll: v.autoRoll,
    notifyEveryAction: v.notifyEveryAction,
    expiresAt: expiryIso(v.expiresOn),
  };
}

/** `PATCH /api/mandates/:id` body with only the changed fields; null when nothing changed. */
export function updateRequest(
  original: MandateView,
  v: MandateFormValues,
): UpdateMandateRequest | null {
  const body: UpdateMandateRequest = {};
  const max = parseDollars(v.maxPrice)!;
  const cap = parseDollars(v.totalCap)!;
  if (max !== original.maxPriceCents) body.maxPriceCents = max;
  if (cap !== original.totalHoldCapCents) body.totalHoldCapCents = cap;
  const sorted = (ids: readonly string[]) => [...ids].sort().join(',');
  if (sorted(v.productIds) !== sorted(original.productIds)) body.productIds = [...v.productIds];
  if (v.autoRoll !== original.autoRoll) body.autoRoll = v.autoRoll;
  if (v.notifyEveryAction !== original.notifyEveryAction) {
    body.notifyEveryAction = v.notifyEveryAction;
  }
  const originalDay = original.expiresAt ? dateInputValue(original.expiresAt) : '';
  if (v.expiresOn !== originalDay) body.expiresAt = expiryIso(v.expiresOn)!;
  return Object.keys(body).length ? body : null;
}

/** Live holds against the cap, for the meter: "$229 of $460 held". */
export function capUsage(liveHoldCents: number, capCents: number) {
  const ratio = capCents > 0 ? liveHoldCents / capCents : 0;
  return {
    percent: Math.min(100, Math.round(ratio * 100)),
    text: `${formatUsd(liveHoldCents)} of ${formatUsd(capCents)} held`,
    roomCents: Math.max(0, capCents - liveHoldCents),
  };
}

function shortDate(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
}

/**
 * Mandates have no name field, so the v4 list (frame 120:784) names one from its limits:
 * "Aurel A7 under $250", "2 products under $250", "Anything under $250".
 */
export function mandateName(m: Pick<MandateView, 'maxPriceCents' | 'products'>): string {
  const under = `under ${formatUsd(m.maxPriceCents)}`;
  if (m.products.length === 0) return `Anything ${under}`;
  if (m.products.length > 1) return `${m.products.length} products ${under}`;
  return `${m.products[0]!.title ?? 'One product'} ${under}`;
}

/** List caption: "Cap $600 · expires Dec 1", "Cap $400 · paused Nov 8", "Cap $600 · revoked". */
export function mandateCaption(
  m: Pick<MandateView, 'totalHoldCapCents' | 'state' | 'expiresAt' | 'pausedAt'>,
  timeZone?: string,
): string {
  const cap = `Cap ${formatUsd(m.totalHoldCapCents)}`;
  switch (m.state) {
    case 'paused':
      return m.pausedAt ? `${cap} · paused ${shortDate(m.pausedAt, timeZone)}` : `${cap} · paused`;
    case 'expired':
      return m.expiresAt ? `${cap} · ended ${shortDate(m.expiresAt, timeZone)}` : `${cap} · ended`;
    case 'fulfilled':
      return `${cap} · item bought`;
    case 'revoked':
      return `${cap} · revoked`;
    default:
      return m.expiresAt ? `${cap} · expires ${shortDate(m.expiresAt, timeZone)}` : cap;
  }
}

/**
 * W17 payment-method row. A method is saved by the shopper's next PayPal or card hold, so
 * "Update →" opens a live offer for one of the mandate's products (else any live product).
 * No live listing: no action rather than a dead link.
 */
export function paymentMethodRow(
  saved: boolean,
  products: ReadonlyArray<{ listingSlug: string | null }>,
  options: ReadonlyArray<{ listingSlug: string | null }>,
): { detail: string; action: { label: string; slug: string } | null } {
  const slug =
    products.find((p) => p.listingSlug)?.listingSlug ??
    options.find((p) => p.listingSlug)?.listingSlug ??
    null;
  return {
    detail: saved
      ? 'Saved for agent holds'
      : 'None saved. Your agent asks before each hold until your next PayPal or card hold saves one.',
    action: slug ? { label: saved ? 'Update' : 'Add one', slug } : null,
  };
}

/**
 * Which mandate the editor shows. `/mandates/:id` → that one; `/mandates/new` → none. On bare
 * `/mandates` the editor keeps the mandate it last acted on (`pinnedId`), so pausing or revoking
 * the default pick doesn't jump to another; otherwise the first active one, else the first.
 */
export function pickMandate<M extends Pick<MandateView, 'mandateId' | 'state'>>(
  mandates: readonly M[],
  route: { creating: boolean; mandateId?: string | undefined; pinnedId?: string | null },
): M | undefined {
  if (route.creating) return undefined;
  if (route.mandateId) return mandates.find((m) => m.mandateId === route.mandateId);
  const pinned = route.pinnedId && mandates.find((m) => m.mandateId === route.pinnedId);
  return pinned || (mandates.find((m) => m.state === 'active') ?? mandates[0]);
}
