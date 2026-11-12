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

/** "Money that waits for the *right price.*": the last words are the orange serif accent. */
export const how = { lead: 'Money that waits for the ', accent: 'right price.' } as const;

/** v4 How it works (frame 102:32): heading lead + serif accent, one line, a tint chip. */
export const steps = [
  {
    n: '01',
    lead: 'Shoppers',
    accent: 'bid.',
    body: 'Their agents place a bid; PayPal holds the money.',
    chip: 'Held, not charged',
  },
  {
    n: '02',
    lead: 'You',
    accent: 'clear.',
    body: 'See the money already waiting, pick a quantity, press Clear.',
    chip: 'Private, no markdown',
  },
  {
    n: '03',
    lead: 'You get',
    accent: 'paid.',
    body: 'Every winner pays their own bid, never more than their hold. Everyone else is released.',
    chip: 'Pay-your-bid',
  },
] as const;

/** Hero chat scene (frame 101:69): an illustration of a shopper's agent prompt, not a live form. */
export const heroChat = {
  modes: ['Bid', 'Watch', 'Reserve', 'Release'],
  active: 'Reserve',
  prompt: 'Reserve an Aurel A7 at $229 unless a store drops under $249',
  ceiling: '$229',
  window: '72h',
  submit: 'Reserve',
} as const;

export const brands = {
  title: 'Same 240 units. Four times the money.',
  lede: 'A liquidator buys the pallet at a fraction of retail. Holdfast fills shoppers’ held bids instead, privately, so your public price never moves.',
  note: 'Demo listing, net to the brand. A winner never pays more than their own bid.',
  /** Illustrative held bids floating over the Holdfast photo. */
  chips: ['$229', '$225', '$219', '$239'],
} as const;

/** "4.3× more": Holdfast net over the liquidator quote, one decimal. */
export function multiple(book = DEMO_BOOK): string {
  return `${(netAfterFee(book.grossCents) / book.liquidatorCents).toFixed(1)}× more`;
}

export const agents = {
  lead: 'Any assistant can place a ',
  accent: 'real, held bid.',
  body: 'Holdfast speaks MCP. Connect your assistant once, set a mandate: a max price, a total hold cap, the products allowed, an expiry. Your agent bids inside it.',
  prompt: '“Bid $229 on the Aurel A7, release it if any store goes under $249.”',
  cta: 'Connect an agent',
  copy: 'Copy',
  copied: 'Copied. Paste it into your terminal.',
} as const;

export type AgentClient = 'claude' | 'codex' | 'opencode';

/**
 * The For-agents code card: how each client connects to the Streamable HTTP `/mcp` endpoint. The
 * token placeholder is illustrative; W19 (/developer) mints the real `hf_mcp_` token.
 */
export function agentSnippets(
  origin: string,
): Record<AgentClient, { label: string; comment: string; code: string }> {
  const url = `${origin.replace(/\/+$/, '')}/mcp`;
  return {
    claude: {
      label: 'Claude Code',
      comment: '# one line, then ask your agent to bid',
      code: `claude mcp add --transport http holdfast \\
  ${url} \\
  --header "Authorization: Bearer hf_mcp_…"`,
    },
    codex: {
      label: 'Codex',
      comment: '# ~/.codex/config.toml; export HOLDFAST_MCP_TOKEN=hf_mcp_…',
      code: `[mcp_servers.holdfast]
url = "${url}"
bearer_token_env_var = "HOLDFAST_MCP_TOKEN"`,
    },
    opencode: {
      label: 'OpenCode',
      comment: '# opencode.json',
      code: `{
  "mcp": {
    "holdfast": {
      "type": "remote",
      "url": "${url}",
      "headers": { "Authorization": "Bearer hf_mcp_…" }
    }
  }
}`,
    },
  };
}

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
    how.lead + how.accent,
    ...steps.flatMap((s) => [`${s.lead} ${s.accent}`, s.body, s.chip]),
    heroChat.prompt,
    ...heroChat.modes,
    brands.title,
    brands.lede,
    brands.note,
    multiple(),
    agents.lead + agents.accent,
    agents.body,
    agents.prompt,
    agents.cta,
    agents.copied,
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
