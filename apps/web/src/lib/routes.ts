/** Paths shared across screens. */
export const DEMO_OFFER_SLUG = 'aurel-a7'; // HF-045 seeds the Aurel Audio listing; confirm the slug there.

export const paths = {
  home: '/',
  brandSignIn: '/brand/sign-in',
  brand: '/brand',
  newListing: '/brand/listings/new',
  listingConsole: (id: string) => `/brand/listings/${encodeURIComponent(id)}`,
  listingSettlement: (id: string) => `/brand/listings/${encodeURIComponent(id)}/settlement`,
  offer: (slug: string) => `/o/${encodeURIComponent(slug)}`,
  bids: '/bids',
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
