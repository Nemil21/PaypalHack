import { formatUsd, type MandateView } from '@holdfast/shared';
import { paths } from './routes';

/**
 * v4 Developer page copy and helpers (plan §3.4, decision 4; frames 113:235 brand, 115:184
 * buyer). Brands get docs only: guides into /docs and the embed snippet, no API keys.
 */

export const brandDeveloper = {
  eyebrow: 'Developer · Brand API',
  title: 'Build on your windows.',
  lede: 'How to build on Holdfast as a brand: the embed widget, share links, and what your shoppers’ agents can do over MCP. Brand API keys aren’t available yet.',
  guidesTitle: 'Guides',
  embedTitle: 'Embed the bid widget',
  embedNote: 'Swap in your listing’s slug, or copy the ready-made tag from Embed & share.',
  reference: 'Full reference in Docs',
} as const;

export const brandGuides: readonly { title: string; body: string; to: string }[] = [
  {
    title: 'Open your first window',
    body: 'Verify your domain, create a listing, share it',
    to: `${paths.docs}#open-a-window`,
  },
  {
    title: 'Embed & share links',
    body: 'Widget, UTM links and QR codes; see stats by source in Embed',
    to: `${paths.docs}#open-a-window`,
  },
  {
    title: 'How shoppers’ agents bid',
    body: 'MCP tools, mandates and why limits are enforced on the server',
    to: `${paths.docs}#mcp-tools`,
  },
  {
    title: 'Clearing and payouts',
    body: 'Pay-your-bid settlement, statements, shipment tracking CSV',
    to: `${paths.docs}#clear-and-get-paid`,
  },
];

export const buyerDeveloper = {
  eyebrow: 'Developer · MCP',
  lead: 'Let your AI agent ',
  accent: 'bid for you.',
  createCta: 'Create token',
  tryLine: 'Then try: “Bid $229 on the Aurel A7, release it if a store goes under $249.”',
  mandatesTitle: 'Mandates',
  mandatesLede: 'The limits your agent bids inside. The server enforces them, not the prompt.',
  toolsTitle: 'Tools your agent gets',
} as const;

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** "Up to $250" / "Cap $600 · Aurel A7 · expires Dec 1" for a mandate row. */
export function mandateSummary(m: MandateView): { title: string; detail: string } {
  const products = m.products.map((p) => p.title).filter(Boolean);
  const parts = [
    `Cap ${formatUsd(m.totalHoldCapCents)}`,
    products.length === 0
      ? 'Any product'
      : products.length === 1
        ? products[0]!
        : `${products[0]} +${products.length - 1}`,
  ];
  if (m.expiresAt) parts.push(`expires ${shortDate(m.expiresAt)}`);
  return { title: `Up to ${formatUsd(m.maxPriceCents)}`, detail: parts.join(' · ') };
}

/** Every user-visible string above, for the copy-rule test. */
export function allDeveloperCopy(): string[] {
  return [
    ...Object.values(brandDeveloper),
    ...brandGuides.flatMap((g) => [g.title, g.body]),
    ...Object.values(buyerDeveloper),
  ];
}
