import { formatUsd } from '@holdfast/shared';
import { paths } from './routes';

/**
 * W01 / M12 landing (HF-057, features/18): copy, numbers and links as data, so the copy rules are
 * unit-tested. Settlement is pay-your-bid (D14): never write "one fair price", "clearing price"
 * or anything that says every winner pays the same.
 */

/** v4 nav (frame 101:5): section links, Docs, Sign in → the role chooser, and Contact us. */
export const nav = {
  sections: [
    { id: 'how-it-works', label: 'How it works' },
    { id: 'for-brands', label: 'For brands' },
    { id: 'for-agents', label: 'For agents' },
    { id: 'pricing', label: 'Pricing' },
  ],
  docs: { label: 'Docs', to: paths.docs },
  signIn: { label: 'Sign in', to: paths.signIn },
  /** Smooth-scrolls to the footer contact card (`#contact`). */
  contact: { label: 'Contact us', href: '#contact' },
} as const;

/**
 * Public demo video (HF-050b). Null until the YouTube link exists: the second hero CTA then opens
 * the interactive demo hub instead of an empty modal.
 */
export const DEMO_VIDEO_URL: string | null = null;

/** `https://youtu.be/ID` or `https://www.youtube.com/watch?v=ID` → privacy-enhanced embed URL. */
export function youtubeEmbedUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'm.youtube.com') {
    id = u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : u.searchParams.get('v');
  }
  if (!id || !/^[\w-]{6,20}$/.test(id)) return null;
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
}

export const hero = {
  headline: 'Clear overstock into money that’s already waiting.',
  sub: 'Shoppers’ AI agents place bids backed by PayPal holds. You see committed demand and sell privately; no public markdown.',
  /** Before / after the accent marker ("already waiting"). */
  headlineLead: 'Clear overstock into money that’s ',
  headlineAccent: 'already waiting',
  copyCta: 'Copy MCP prompt',
  copied: 'Copied',
  copiedBody: 'Paste it into Claude Code, Codex or OpenCode.',
  videoCta: 'Watch the 2-min demo',
  demoCta: 'Try the live demo',
} as const;

/**
 * Hero "Copy MCP prompt": one prompt any coding agent (Claude Code, Codex, OpenCode) can follow to
 * connect Holdfast's Streamable HTTP MCP server. The token comes from W19 (/developer).
 */
export function mcpPrompt(origin: string): string {
  const base = origin.replace(/\/+$/, '');
  return [
    `Connect the Holdfast MCP server to this agent: Streamable HTTP at ${base}/mcp,`,
    `with the header "Authorization: Bearer <token>". I'll create the hf_mcp_ token at ${base}${paths.developer}.`,
    'Then list my Holdfast tools and help me place a held bid on the Aurel A7.',
  ].join(' ');
}

/** The demo book (HOLDFAST-SPEC §4): 240 units clear at a $219 cutoff, each at the winner's own bid. */
export const DEMO_BOOK = {
  heldCents: 6_124_000,
  cutoffCents: 21_900,
  quantity: 240,
  grossCents: 5_424_000,
  liquidatorCents: 1_140_000,
} as const;

/** Holdfast's success fee: 9% of what clears, nothing if nothing clears. */
export const FEE_RATE = 0.09;

export function netAfterFee(grossCents: number): number {
  return Math.round(grossCents * (1 - FEE_RATE));
}

/** "$49.4k" style, for the comparison bar. */
export function compactUsd(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return formatUsd(cents);
}

export interface ComparisonRow {
  label: string;
  detail: string;
  cents: number;
  /** Bar width as a share of the larger row, 0..1. */
  share: number;
  tone: 'muted' | 'accent';
}

export function comparison(book = DEMO_BOOK): ComparisonRow[] {
  const net = netAfterFee(book.grossCents);
  const max = Math.max(net, book.liquidatorCents);
  return [
    {
      label: 'Liquidator',
      detail: `${book.quantity} units, one pallet quote`,
      cents: book.liquidatorCents,
      share: book.liquidatorCents / max,
      tone: 'muted',
    },
    {
      label: 'Holdfast',
      detail: `${book.quantity} units, each at its own bid, after our 9%`,
      cents: net,
      share: net / max,
      tone: 'accent',
    },
  ];
}

export const steps = [
  {
    n: '01',
    title: 'Shoppers bid',
    body: 'Shoppers and their agents bid on your exact product. PayPal holds the money. Held, not charged.',
  },
  {
    n: '02',
    title: 'You clear',
    body: 'You see the demand curve of money already waiting, choose how many units, and press Clear.',
  },
  {
    n: '03',
    title: 'You get paid',
    body: 'Every winner pays their own bid, never more than their hold. Everyone else is released, and you get paid.',
  },
] as const;

export const agents = {
  title: 'Any assistant can place a real, held bid.',
  body: 'Holdfast speaks MCP. A shopper connects Claude or any MCP client once, sets a mandate, and their agent bids inside it: a max price, a total hold cap, the products allowed, an expiry.',
  /** Illustrative only: W19 (/developer) generates the real config with the shopper's token. */
  snippet: `{
  "mcpServers": {
    "holdfast": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-holdfast>/mcp",
               "--header", "Authorization:\${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer hf_mcp_…" }
    }
  }
}`,
  prompt: '“Bid $229 on the Aurel A7, release it if any store goes under $249.”',
} as const;

/** "9% of what clears." with a solid orange bar under the accent. */
export const pricing = {
  lead: '9% of ',
  accent: 'what clears.',
  sub: 'Nothing if nothing clears.',
  pills: ['No listing fees', 'No setup', 'No monthly plan'],
  cta: 'Watch the demo',
} as const;

export const GITHUB_URL = 'https://github.com/Nemil21/PaypalHack';

/**
 * Footer credits: only tools the product actually uses (README "Sponsor tools", HF-049). Bryntum
 * Gantt is in use (HF-060: console, Settlement, Payouts, Bid detail; v4 decision 1). APIMatic is
 * listed there as unclaimed, so it is not credited here.
 */
export const sponsors = ['PayPal', 'AG Grid', 'Channel3', 'Render', 'Bryntum'] as const;

/** v4 footer (frame 104:75, `id="contact"`). */
export const footer = {
  tagline: 'Shoppers’ agents hold real money for your overstock; you clear it privately.',
  contactTitle: 'Contact us',
  contact: {
    name: 'Nemil Shah',
    url: 'https://www.linkedin.com/in/nemil-shah21/',
    display: 'linkedin.com/in/nemil-shah21',
  },
  builtWith: 'Built with',
} as const;

/** Every user-visible string above, for the copy-rule test. */
export function allCopy(): string[] {
  return [
    ...nav.sections.map((s) => s.label),
    nav.docs.label,
    nav.signIn.label,
    nav.contact.label,
    ...Object.values(hero),
    ...steps.flatMap((s) => [s.title, s.body]),
    agents.title,
    agents.body,
    agents.prompt,
    pricing.lead + pricing.accent,
    pricing.sub,
    ...pricing.pills,
    pricing.cta,
    footer.tagline,
    footer.contactTitle,
    footer.builtWith,
    ...comparison().flatMap((r) => [r.label, r.detail]),
  ];
}
