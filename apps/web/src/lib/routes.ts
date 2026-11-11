/** Paths shared across screens. */
export const DEMO_OFFER_SLUG = 'aurel-a7'; // HF-045 seeds the Aurel Audio listing; confirm the slug there.

export const paths = {
  home: '/',
  /** HF-007 demo hub: three ways in for judges; the W01 landing (HF-057) took over `/`. */
  demo: '/demo',
  brandSignIn: '/brand/sign-in',
  brandOnboarding: '/brand/onboarding',
  brand: '/brand',
  newListing: '/brand/listings/new',
  /** W04 left nav (HF-026): W09 payouts (HF-059b), W10 embed (HF-055), W11 settings (HF-056). */
  brandPayouts: '/brand/payouts',
  brandEmbed: '/brand/embed',
  brandSettings: '/brand/settings',
  /** Invite link landing (HF-056): `/brand/join#hfi_…`. */
  brandJoin: '/brand/join',
  listingConsole: (id: string) => `/brand/listings/${encodeURIComponent(id)}`,
  listingSettlement: (id: string) => `/brand/listings/${encodeURIComponent(id)}/settlement`,
  offer: (slug: string) => `/o/${encodeURIComponent(slug)}`,
  bids: '/bids',
  /** W18 / M08 won page (HF-059a). */
  bidWon: (bidId: string) => `/bids/${encodeURIComponent(bidId)}/won`,
  agent: '/agent',
  mandates: '/mandates',
  /** W17 / M09 new mandate; W13 "Let my agent manage this" (HF-020) prefills the product and price. */
  newMandate: (prefill: { productId?: string; maxPriceCents?: number } = {}) => {
    const q = new URLSearchParams();
    if (prefill.productId) q.set('productId', prefill.productId);
    if (prefill.maxPriceCents) q.set('maxPriceCents', String(prefill.maxPriceCents));
    const qs = q.toString();
    return qs ? `/mandates/new?${qs}` : '/mandates/new';
  },
  mandate: (mandateId: string) => `/mandates/${encodeURIComponent(mandateId)}`,
  developer: '/developer',
  admin: '/admin',
  devComponents: '/dev/components',
} as const;
