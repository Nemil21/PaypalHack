import {
  createListingRequestSchema,
  formatUsd,
  LISTING_WINDOW_HOURS,
  MAX_AMOUNT_CENTS,
  MAX_LISTING_QUANTITY,
  MIN_AMOUNT_CENTS,
  type CreateListingRequest,
  type CreateListingResponse,
  type ListingWindowHours,
  type PublishListingResponse,
} from '@holdfast/shared';
import {
  ApiAction,
  requestFingerprint,
  type ApiClient,
  type ApiError,
  type ApiRequest,
} from './api';
import { parseDollars } from './mandate-form';

/**
 * W05 create-listing wizard logic (HF-013; features/02 §Logic 1–6), kept free of React so it is
 * unit-tested. Client validation mirrors the server's (`createListingRequestSchema`, HF-012a's
 * floor rule and HF-009's GTIN check digit); the server stays the authority.
 *
 * Idempotency: one `ListingSubmitter` per wizard session. Its `POST /api/listings` reuses one key
 * for the session (a retry or a second click replays the same draft); the key changes only when
 * the listing itself changes, because the server answers 422 to a reused key with another body.
 */

export const SEARCH_MIN_CHARS = 3;
export const SEARCH_DEBOUNCE_MS = 400;
/** The Step 4 estimate assumes this share of the quantity clears at the floor (02 §Logic 4). */
export const ESTIMATE_CLEAR_SHARE = 0.6;
/** `liquidationQuoteCents` bound in `createListingRequestSchema`. */
export const MAX_LIQUIDATION_CENTS = 100_000_000;

export const WIZARD_STEPS = ['Product', 'Quantity & price', 'Window', 'Review'] as const;
export type WizardStep = 0 | 1 | 2 | 3;

/** One row of `GET /api/products/search` (HF-009 `ProductSearchResult`). */
export interface ProductSearchHit {
  channel3Id: string;
  variant: string | null;
  variantLabel: string | null;
  title: string;
  brandName: string | null;
  gtin: string | null;
  mpn: string | null;
  imageUrl: string | null;
  bestPublicPriceCents: number | null;
  offerCount: number;
  condition: 'NEW' | 'USED';
  /** Brand sessions: whether the product's brand matches the signed-in brand. */
  brandMatch: boolean | null;
}

/** Trimmed query to send, or null while it is too short to search. */
export function searchQuery(input: string): string | null {
  const q = input.trim();
  return q.length >= SEARCH_MIN_CHARS ? q : null;
}

export type HitBlock = 'NOT_YOUR_BRAND' | 'NOT_NEW';

/**
 * Why a search hit can't be listed, or null when it can (02 §Logic 1): only NEW products whose
 * brand matches the verified brand. `brandMatch: null` (no brand in session) is not a match.
 */
export function hitBlock(hit: Pick<ProductSearchHit, 'brandMatch' | 'condition'>): HitBlock | null {
  if (hit.brandMatch !== true) return 'NOT_YOUR_BRAND';
  if (hit.condition !== 'NEW') return 'NOT_NEW';
  return null;
}

export const HIT_BLOCK_LABEL: Record<HitBlock, string> = {
  NOT_YOUR_BRAND: 'Not your brand',
  NOT_NEW: 'Not sold new',
};

// --- Identifiers ----------------------------------------------------------------------------------

/**
 * Digits only; null unless 8, 12, 13 or 14 digits with a valid GS1 check digit. Mirrors core's
 * `normalizeGtin` (HF-009), which the server applies to an entered GTIN (`INVALID_GTIN`).
 */
export function normalizeGtin(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[\s-]/g, '');
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return null;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1)) ? digits : null;
}

// --- Form ------------------------------------------------------------------------------------------

export interface WizardValues {
  /** The picked search hit; null with `manual` (Channel3 down or the brand typed it). */
  hit: ProductSearchHit | null;
  manual: boolean;
  /** Manual listings only. */
  title: string;
  /** Typed identifiers: required when the catalogue has neither, or for a manual listing. */
  gtin: string;
  mpn: string;
  /** Whole units as typed. */
  quantity: string;
  /** Dollars as typed, e.g. "199" or "199.50". */
  floor: string;
  liquidation: string;
  windowHours: ListingWindowHours;
}

export const emptyWizard = (): WizardValues => ({
  hit: null,
  manual: false,
  title: '',
  gtin: '',
  mpn: '',
  quantity: '',
  floor: '',
  liquidation: '',
  windowHours: 48,
});

export type WizardField =
  'product' | 'title' | 'gtin' | 'quantity' | 'floor' | 'liquidation' | 'windowHours';
export type WizardErrors = Partial<Record<WizardField, string>>;

/** Cheapest public price, or null when unknown (manual entry, or no new USD offer). */
export function publicLowCents(v: Pick<WizardValues, 'hit' | 'manual'>): number | null {
  return v.manual ? null : (v.hit?.bestPublicPriceCents ?? null);
}

/** Whether the catalogue has no identifier, so the brand must type a GTIN or MPN. */
export function needsIdentifier(v: Pick<WizardValues, 'hit' | 'manual'>): boolean {
  return v.manual || !v.hit || (!v.hit.gtin && !v.hit.mpn);
}

/** Server rule (HF-012a): `floor < best public price`, skipped when the public price is unknown. */
export function floorBelowPublic(floorCents: number, bestPublicPriceCents: number | null): boolean {
  return bestPublicPriceCents === null || floorCents < bestPublicPriceCents;
}

export const FLOOR_ABOVE_PUBLIC = 'No one will bid above a cheaper store.';

export function validateProduct(v: WizardValues): WizardErrors {
  const e: WizardErrors = {};
  if (v.manual) {
    if (!v.title.trim()) e.title = 'Enter the product name.';
  } else if (!v.hit) {
    e.product = 'Pick your product.';
  } else {
    const block = hitBlock(v.hit);
    if (block) e.product = `${HIT_BLOCK_LABEL[block]}: pick another product.`;
  }
  const gtin = v.gtin.trim();
  if (gtin && !normalizeGtin(gtin)) {
    e.gtin = 'That GTIN is not valid (8, 12, 13 or 14 digits with a check digit).';
  } else if (needsIdentifier(v) && !gtin && !v.mpn.trim()) {
    e.gtin = 'Enter the GTIN or MPN so the product can be matched exactly.';
  }
  return e;
}

/** Whole units: "300" or "1,200" → 300 / 1200; anything else → null. */
export function parseQuantity(input: string): number | null {
  const s = input.trim().replaceAll(',', '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function validatePricing(v: WizardValues): WizardErrors {
  const e: WizardErrors = {};
  const qty = parseQuantity(v.quantity);
  if (qty === null || qty < 1) e.quantity = 'Enter at least 1 unit.';
  else if (qty > MAX_LISTING_QUANTITY) {
    e.quantity = `At most ${MAX_LISTING_QUANTITY.toLocaleString('en-US')} units.`;
  }

  const floor = parseDollars(v.floor);
  const low = publicLowCents(v);
  if (floor === null) e.floor = 'Enter a floor price, like 199.';
  else if (floor < MIN_AMOUNT_CENTS || floor > MAX_AMOUNT_CENTS) {
    e.floor = `Floor must be between ${formatUsd(MIN_AMOUNT_CENTS)} and ${formatUsd(MAX_AMOUNT_CENTS)}.`;
  } else if (!floorBelowPublic(floor, low)) {
    e.floor = `${FLOOR_ABOVE_PUBLIC} The cheapest public price is ${formatUsd(low!)}.`;
  }

  const liq = parseDollars(v.liquidation);
  if (liq === null) e.liquidation = 'Enter your liquidator’s quote per unit, like 80.';
  else if (liq > MAX_LIQUIDATION_CENTS) e.liquidation = 'That quote is too large.';
  return e;
}

export function validateWindow(v: WizardValues): WizardErrors {
  return (LISTING_WINDOW_HOURS as readonly number[]).includes(v.windowHours)
    ? {}
    : { windowHours: 'Choose 24 or 48 hours.' };
}

const STEP_VALIDATORS = [validateProduct, validatePricing, validateWindow] as const;

/** Errors for one step (Review re-checks every step). */
export function validateStep(step: WizardStep, v: WizardValues): WizardErrors {
  if (step === 3) return validateAll(v);
  return STEP_VALIDATORS[step](v);
}

export function validateAll(v: WizardValues): WizardErrors {
  return { ...validateProduct(v), ...validatePricing(v), ...validateWindow(v) };
}

/** First step with an error, or null when the listing is ready to submit. */
export function firstInvalidStep(v: WizardValues): WizardStep | null {
  for (const step of [0, 1, 2] as const) {
    if (Object.keys(STEP_VALIDATORS[step](v)).length) return step;
  }
  return null;
}

/**
 * The `POST /api/listings` body, or null while the form is invalid. The last gate is the shared
 * request schema the API parses with, so the client can't send what the server would refuse.
 */
export function buildCreateRequest(v: WizardValues): CreateListingRequest | null {
  if (firstInvalidStep(v) !== null) return null;
  const gtin = v.gtin.trim();
  const mpn = v.mpn.trim();
  const body: CreateListingRequest = {
    ...(v.manual
      ? { title: v.title.trim() }
      : { channel3Id: v.hit!.channel3Id, variant: v.hit!.variant }),
    ...(gtin ? { gtin: normalizeGtin(gtin)! } : {}),
    ...(mpn ? { mpn } : {}),
    quantity: parseQuantity(v.quantity)!,
    floorCents: parseDollars(v.floor)!,
    liquidationQuoteCents: parseDollars(v.liquidation)!,
    windowHours: v.windowHours,
  };
  const parsed = createListingRequestSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

// --- Review estimate --------------------------------------------------------------------------------

export interface ListingEstimate {
  /** Units assumed to clear: 60% of the quantity, rounded down. */
  units: number;
  /** Those units at the floor. */
  holdfastCents: number;
  /** The same units at the liquidator's quote. */
  liquidationCents: number;
  /** `holdfastCents - liquidationCents`. */
  upliftCents: number;
}

/** "If 60% of quantity clears at the floor: $X vs $Y liquidation" (02 §Logic 4). */
export function estimate(quantity: number, floorCents: number, liquidationCents: number) {
  const units = Math.floor(quantity * ESTIMATE_CLEAR_SHARE);
  const holdfastCents = units * floorCents;
  const liq = units * liquidationCents;
  return {
    units,
    holdfastCents,
    liquidationCents: liq,
    upliftCents: holdfastCents - liq,
  } satisfies ListingEstimate;
}

export function estimateLine(e: ListingEstimate): string {
  const pct = Math.round(ESTIMATE_CLEAR_SHARE * 100);
  return `If ${pct}% of quantity clears at the floor: ${formatUsd(e.holdfastCents)} vs ${formatUsd(e.liquidationCents)} liquidation.`;
}

export function floorHelper(publicLow: number | null): string {
  return publicLow === null
    ? 'Public price unknown, so price watch is off for this listing. Floor is private; shoppers never see it.'
    : `Cheapest public price ${formatUsd(publicLow)}. Floor is private; shoppers never see it.`;
}

// --- Submit ----------------------------------------------------------------------------------------

export interface PublishOutcome {
  draft: CreateListingResponse;
  published: PublishListingResponse;
}

/**
 * Save draft / Publish for one wizard session. Concurrent calls (a double-click, Enter + click)
 * share the in-flight promise, so one click sequence sends one create. `POST /api/listings` keeps
 * one Idempotency-Key per unchanged body; once a draft exists for a body, Publish reuses it
 * instead of creating another.
 */
export class ListingSubmitter {
  private readonly create: ApiAction;
  private readonly publishAction: ApiAction;
  private draft: { fingerprint: string; value: CreateListingResponse } | null = null;
  private inflight: Promise<unknown> | null = null;

  constructor(client: ApiClient, mintKey?: () => string) {
    this.create = new ApiAction(client, mintKey);
    this.publishAction = new ApiAction(client, mintKey);
  }

  /** The draft created so far in this session, if any. */
  get currentDraft(): CreateListingResponse | null {
    return this.draft?.value ?? null;
  }

  get busy(): boolean {
    return this.inflight !== null;
  }

  saveDraft(body: CreateListingRequest): Promise<CreateListingResponse> {
    return this.once(() => this.ensureDraft(body));
  }

  publish(body: CreateListingRequest): Promise<PublishOutcome> {
    return this.once(async () => {
      const draft = await this.ensureDraft(body);
      const published = await this.publishAction.run<PublishListingResponse>({
        method: 'POST',
        path: `/api/listings/${encodeURIComponent(draft.listingId)}/publish`,
      });
      return { draft, published };
    });
  }

  private once<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflight) return this.inflight as Promise<T>;
    const p = fn().finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async ensureDraft(body: CreateListingRequest): Promise<CreateListingResponse> {
    const req: ApiRequest = { method: 'POST', path: '/api/listings', body };
    const fingerprint = requestFingerprint(req);
    if (this.draft?.fingerprint === fingerprint) return this.draft.value;
    const value = await this.create.run<CreateListingResponse>(req);
    this.draft = { fingerprint, value };
    return value;
  }
}

const LIVE_STATUSES: readonly string[] = ['OPEN', 'ROUNDS', 'CLEARING'];

/**
 * Where "Open the live listing" goes after a 409 DUPLICATE. The create call refuses before any
 * draft exists, so the envelope's `existingListingId` is the source; failing that, a live listing
 * of the same product among the brand's loaded listings; else null (the caller falls back).
 */
export function duplicateListingId(
  err: Pick<ApiError, 'code' | 'details'>,
  listings: readonly { listingId: string; status: string; product: { productId: string } }[],
  productId: string | null | undefined,
): string | null {
  if (err.code !== 'DUPLICATE') return null;
  const id = err.details.existingListingId;
  if (typeof id === 'string' && id) return id;
  if (!productId) return null;
  return (
    listings.find((l) => l.product.productId === productId && LIVE_STATUSES.includes(l.status))
      ?.listingId ?? null
  );
}

/** Wizard copy for an API error (W05 states). */
export function submitErrorMessage(err: ApiError): string {
  switch (err.code) {
    case 'BRAND_NOT_VERIFIED':
      return 'Your brand must be verified before you can publish. Your draft is saved.';
    case 'DUPLICATE':
      return 'This product already has a live listing. Open it instead of publishing another.';
    default:
      return err.message;
  }
}
