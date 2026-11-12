import { paths } from './routes';

/**
 * v4 sign-in copy (plan §0 / §2.1; Figma 109:63, 109:112, 109:132). Two separate sessions:
 * brands sign in with PayPal only (`hf_brand`), buyers by email link only (`hf_shopper`), so the
 * role is chosen first. Headings split into plain text plus one orange serif-italic accent.
 */

export interface Heading {
  lead: string;
  accent: string;
  tail?: string;
}

export interface RoleCard {
  role: 'brand' | 'buyer';
  eyebrow: string;
  title: string;
  body: string;
  points: readonly string[];
  cta: string;
  to: string;
}

export const CHOOSER = {
  eyebrow: 'Sign in',
  heading: { lead: 'How are you ', accent: 'using', tail: ' Holdfast?' },
  lede: 'Pick one. You can switch later from Settings.',
  sandbox: 'Sandbox demo · no real money moves',
  hubLead: 'Just looking?',
  hub: 'Open the demo hub',
} as const satisfies { heading: Heading } & Record<string, unknown>;

export const ROLE_CARDS: readonly RoleCard[] = [
  {
    role: 'brand',
    eyebrow: 'I’m a brand',
    title: 'Sell overstock',
    body: 'Open a private window, see held demand, and clear it without a public markdown.',
    points: ['Listings & demand curve', 'Payouts to PayPal', 'Team & domain verification'],
    cta: 'Continue as a brand',
    to: paths.brandSignIn,
  },
  {
    role: 'buyer',
    eyebrow: 'I’m a buyer',
    title: 'Place held bids',
    body: 'Name your price on a product. PayPal holds it; you only pay if you win.',
    points: ['Bids held, not charged', 'Let your AI agent bid', 'Release any time'],
    cta: 'Continue as a buyer',
    to: paths.buyerSignIn,
  },
];

export const BRAND_SIGN_IN = {
  eyebrow: 'Brand · Sign in',
  heading: { lead: 'Welcome back to your ', accent: 'windows.' },
  lede: 'Sign in with the PayPal business account your payouts go to. First time? You’ll verify your domain next.',
  paypal: 'Continue with PayPal',
  redirecting: 'Redirecting to PayPal…',
  paypalNote:
    'Your PayPal account becomes your payout account. You can change it later in Settings.',
  demoOwner: 'Demo: enter as owner',
  demoViewer: 'Demo: enter as viewer (read-only)',
  footnote: 'Brands sign in with PayPal only. There is no email sign-in for brands.',
} as const satisfies { heading: Heading } & Record<string, unknown>;

export const BUYER_SIGN_IN = {
  eyebrow: 'Buyer · Sign in',
  heading: { lead: 'Your bids, ', accent: 'held not charged.' },
  lede: 'We email you a one-time sign-in link. No password, no PayPal login needed to look around.',
  emailLabel: 'Email',
  send: 'Email me a sign-in link',
  linkNote: 'Link is valid for 15 minutes.',
  placeBidLead: 'Or just',
  placeBid: 'place a bid',
  placeBidTail: ': PayPal identifies you when you hold.',
  sent: (email: string) =>
    `We sent a sign-in link to ${email}. It works for 15 minutes. (Running locally? It’s printed in the server console.)`,
  demoMaya: 'Demo: enter as Maya',
} as const satisfies { heading: Heading } & Record<string, unknown>;

export const SHARED = {
  changeRole: 'Change role',
  orTryIt: 'or try it',
  demoBadge: 'Demo mode · PayPal sandbox',
} as const;

/** Invite landing (§4.4): brand sign-in with the inviting brand in the heading. */
export function inviteHeading(brandName: string): Heading {
  return { lead: 'You’re invited to ', accent: `${brandName}.` };
}

/** Carries a same-origin `next` through the role chooser to the chosen sign-in page. */
export function withNext(to: string, next: string | undefined): string {
  return next ? `${to}?next=${encodeURIComponent(next)}` : to;
}

/** Every user-facing string above, for the copy-rule test (D14). */
export function allSignInCopy(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') out.push(String((v as (s: string) => string)('x@y.z')));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk([CHOOSER, ROLE_CARDS, BRAND_SIGN_IN, BUYER_SIGN_IN, SHARED, inviteHeading('Aurel')]);
  return out;
}
