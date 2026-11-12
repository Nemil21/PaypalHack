import { MCP_TOOL_DOCS } from '@holdfast/shared';
import { paths } from './routes';

/**
 * v4 Docs page (Figma `107:137`, plan §1 / §3.7): static copy as data, so the pay-your-bid copy
 * rule (D14) is unit-tested like the landing. Sidebar groups link to the sections by id; the
 * brand Developer page (§3.4) links its guides here too.
 */

export interface DocsLink {
  id: string;
  label: string;
}

export const docsNav: readonly { group: string; links: readonly DocsLink[] }[] = [
  {
    group: 'Get started',
    links: [
      { id: 'overview', label: 'Overview' },
      { id: 'connect-an-agent', label: 'Connect an agent' },
      { id: 'set-a-mandate', label: 'Set a mandate' },
      { id: 'place-a-bid', label: 'Place a bid' },
    ],
  },
  {
    group: 'For brands',
    links: [
      { id: 'verify-your-domain', label: 'Verify your domain' },
      { id: 'open-a-window', label: 'Open a window' },
      { id: 'clear-and-get-paid', label: 'Clear and get paid' },
    ],
  },
  {
    group: 'Reference',
    links: [
      { id: 'mcp-tools', label: 'MCP tools' },
      { id: 'rest-api', label: 'REST API' },
      { id: 'webhooks', label: 'Webhooks' },
    ],
  },
];

export const docsHero = {
  eyebrow: 'Docs · Get started',
  lead: 'Connect an agent in ',
  accent: 'one line.',
  lede: 'Holdfast speaks MCP. Add it to your assistant, set a mandate, and your agent can place real bids backed by PayPal holds.',
} as const;

/** The three numbered steps under the hero (`#connect-an-agent`). */
export const docsSteps = [
  {
    title: 'Add Holdfast to your client',
    body: `Create a token on the Developer page, then add the server to Claude Code, Codex or OpenCode.`,
  },
  {
    title: 'Set a mandate',
    body: 'Max price, total hold cap, allowed products and an expiry. The server enforces it, not the prompt.',
  },
  {
    title: 'Ask your agent to bid',
    body: '“Bid $229 on the Aurel A7, release it if any store goes under $249.”',
  },
] as const;

export interface DocsSection {
  id: string;
  title: string;
  paragraphs: readonly string[];
  /** In-app links shown under the section. */
  links?: readonly { label: string; to: string }[];
}

export const docsSections: readonly DocsSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    paragraphs: [
      'Shoppers, or the AI agents acting for them, bid on a brand’s exact product. Each bid is a real PayPal hold: held, not charged.',
      'The brand sees the money already waiting and fills as many units as it chooses, privately, so its public price never moves. Every winner pays their own bid, never more than their hold. Everyone else is released.',
      'Holdfast takes 9% of what clears, and nothing if nothing clears.',
    ],
    links: [{ label: 'Open the demo hub', to: paths.demo }],
  },
  {
    id: 'set-a-mandate',
    title: 'Set a mandate',
    paragraphs: [
      'A mandate is the limit your agent bids inside: a max price per bid, a total hold cap across bids, the products it may bid on, and an expiry. Pause it at any time; pausing releases its holds.',
      'With a saved card and an active mandate that covers the amount, place_bid lands a held bid at once. Without them, nothing is held and your agent gets a link for you to approve the PayPal hold yourself.',
    ],
    links: [
      { label: 'Set a mandate', to: paths.newMandate() },
      { label: 'All mandates', to: paths.mandates },
    ],
  },
  {
    id: 'place-a-bid',
    title: 'Place a bid',
    paragraphs: [
      'Ask in plain words. The agent calls get_book to read the listing, then place_bid with an amount in integer US cents (21500 = $215.00) and an idempotency key, so a retry never places a second hold.',
      'You hold one live bid per listing. raise_bid moves it up with a new hold and releases the old one; cancel_bid releases it. If you win, you are charged exactly your bid.',
    ],
    links: [{ label: 'My bids', to: paths.bids }],
  },
  {
    id: 'verify-your-domain',
    title: 'Verify your domain',
    paragraphs: [
      'Brands sign in with PayPal, then add their company and domain. Holdfast gives you a DNS TXT record; add it at your DNS host and press Check. Only verified brands can open a window.',
    ],
    links: [
      { label: 'Brand sign-in', to: paths.brandSignIn },
      { label: 'Verify your brand', to: paths.brandOnboarding },
    ],
  },
  {
    id: 'open-a-window',
    title: 'Open a window',
    paragraphs: [
      'Create a listing: pick the exact product (matched against live retailer offers), set your floor, the units on offer and when the bidding window closes, then publish.',
      'Share the offer link, or embed the bid widget on your own store with one script tag. Embed shows bids by source.',
    ],
    links: [
      { label: 'New listing', to: paths.newListing },
      { label: 'Embed & share', to: paths.brandEmbed },
    ],
  },
  {
    id: 'clear-and-get-paid',
    title: 'Clear and get paid',
    paragraphs: [
      'The console shows the demand curve of held money. Choose how many units to fill and press Clear. The highest bids win and each winner pays their own bid; every other hold is released.',
      'Settlement captures each winner, then pays you out through PayPal after the 9% fee. Statements and shipment tracking live on Payouts.',
    ],
    links: [{ label: 'Payouts', to: paths.brandPayouts }],
  },
];

export const docsReference = {
  mcp: {
    title: 'MCP tools',
    lede: 'Streamable HTTP at /mcp with a bearer token from the Developer page. Read tokens can look; Bid tokens can place real holds. 30 calls a minute per token.',
    tools: MCP_TOOL_DOCS,
  },
  rest: {
    title: 'REST API',
    paragraphs: [
      'The web app runs on a same-origin JSON API under /api with session cookies. For example, GET /api/offers/:slug reads a public offer and GET /api/widget/:slug feeds the embed widget.',
      'Brand API keys aren’t available yet; to build on Holdfast, use MCP or the embed widget.',
    ],
  },
  webhooks: {
    title: 'Webhooks',
    paragraphs: [
      'Holdfast receives PayPal webhooks (holds, captures, payouts) and Channel3 price-change webhooks for the price watcher. Outbound webhooks for brands aren’t available yet.',
    ],
  },
} as const;

/** Every user-visible string, for the copy-rule test. */
export function allDocsCopy(): string[] {
  return [
    ...docsNav.flatMap((g) => [g.group, ...g.links.map((l) => l.label)]),
    ...Object.values(docsHero),
    ...docsSteps.flatMap((s) => [s.title, s.body]),
    ...docsSections.flatMap((s) => [
      s.title,
      ...s.paragraphs,
      ...(s.links ?? []).map((l) => l.label),
    ]),
    docsReference.mcp.title,
    docsReference.mcp.lede,
    docsReference.rest.title,
    ...docsReference.rest.paragraphs,
    docsReference.webhooks.title,
    ...docsReference.webhooks.paragraphs,
  ];
}
