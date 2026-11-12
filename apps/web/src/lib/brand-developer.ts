import { paths } from './routes';

/**
 * v4 brand Developer view (Figma 113:235, plan §3.4, decision 4): docs only. Guides into `/docs`
 * and the embed-widget snippet; no brand API keys, no webhooks, no "Create API key" button.
 */

export const BRAND_DEVELOPER = {
  eyebrow: 'Developer · Brand API',
  title: 'Build on your windows.',
  lede: 'How to build on Holdfast as a brand: the embed widget, share links, and what your shoppers’ agents can do over MCP. Brand API keys aren’t available yet.',
  guidesTitle: 'Guides',
  readInDocs: 'Read in Docs',
  embedTitle: 'Embed the bid widget',
  embedNote:
    'Paste it where the product is sold. Bids from the widget are tracked by source in Embed.',
  fullReference: 'Full reference in Docs',
  openEmbed: 'Open Embed & share',
} as const;

export interface Guide {
  title: string;
  body: string;
  to: string;
}

const doc = (id: string) => `${paths.docs}#${id}`;

export const BRAND_GUIDES: readonly Guide[] = [
  {
    title: 'Open your first window',
    body: 'Verify your domain, create a listing, share it',
    to: doc('verify-your-domain'),
  },
  {
    title: 'Embed & share links',
    body: 'Widget, UTM links and QR codes; see stats by source in Embed',
    to: doc('open-a-window'),
  },
  {
    title: 'How shoppers’ agents bid',
    body: 'MCP tools, mandates and why limits are enforced on the server',
    to: doc('mcp-tools'),
  },
  {
    title: 'Clearing and payouts',
    body: 'Pay-your-bid settlement, statements, shipment tracking CSV',
    to: doc('clear-and-get-paid'),
  },
];

/** Every user-facing string, for the copy tests. */
export function allBrandDeveloperCopy(): string[] {
  return [...Object.values(BRAND_DEVELOPER), ...BRAND_GUIDES.flatMap((g) => [g.title, g.body])];
}
