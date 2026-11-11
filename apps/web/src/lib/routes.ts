/** Paths shared across screens. */
export const DEMO_OFFER_SLUG = 'aurel-a7'; // HF-045 seeds the Aurel Audio listing; confirm the slug there.

export const paths = {
  home: '/',
  brandSignIn: '/brand/sign-in',
  brand: '/brand',
  offer: (slug: string) => `/o/${encodeURIComponent(slug)}`,
  bids: '/bids',
  agent: '/agent',
  mandates: '/mandates',
  developer: '/developer',
  admin: '/admin',
  devComponents: '/dev/components',
} as const;
