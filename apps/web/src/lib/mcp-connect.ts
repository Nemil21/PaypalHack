import {
  formatUsd,
  MCP_TOKEN_PREFIX,
  type MandateListBody,
  type MandateView,
  type McpToolParam,
} from '@holdfast/shared';
import { DEMO_OFFER_SLUG } from './routes';

/**
 * W19 Developer / MCP connect (HF-043; features/07 §Logic 1, screens.md §W19): the Claude Desktop
 * config snippet and the readiness panel (M23), as pure functions so they are unit-tested.
 */

/** Shown in the snippet until a token has just been created. */
export const TOKEN_PLACEHOLDER = `${MCP_TOKEN_PREFIX}…`;

export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

/**
 * `claude_desktop_config.json` in the env form: the header value sits in `env`, so the `args`
 * carry no space (`Authorization:${AUTH_HEADER}`), which some Claude Desktop builds split on.
 */
export function claudeDesktopConfig(origin: string, token: string | null): string {
  const config = {
    mcpServers: {
      holdfast: {
        command: 'npx',
        args: ['mcp-remote', mcpEndpoint(origin), '--header', 'Authorization:${AUTH_HEADER}'],
        env: { AUTH_HEADER: `Bearer ${token ?? TOKEN_PLACEHOLDER}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

export interface Readiness {
  /** A vaulted PayPal method (S2), so a hold needs no approval click. */
  savedCard: boolean;
  /** The ACTIVE mandate that covers the largest bid right now, if any. */
  mandate: { mandateId: string; coversCents: number; label: string } | null;
  /** Both: `place_bid` lands a HELD bid at once instead of returning the offer-page link. */
  ready: boolean;
  /** Offer page to vault a card on: a live listing a mandate allows, else the demo listing. */
  offerSlug: string;
}

/**
 * Readiness from `GET /api/mandates`. A mandate covers up to the smaller of its max price and its
 * unused hold cap; a paused, expired, fulfilled or exhausted mandate covers nothing.
 */
export function readiness(body: MandateListBody | null): Readiness {
  let best: Readiness['mandate'] = null;
  for (const m of body?.mandates ?? []) {
    if (m.state !== 'active') continue;
    const coversCents = Math.min(m.maxPriceCents, m.totalHoldCapCents - m.liveHoldCents);
    if (coversCents <= 0) continue;
    if (!best || coversCents > best.coversCents) {
      best = { mandateId: m.mandateId, coversCents, label: formatUsd(coversCents) };
    }
  }
  const savedCard = body?.savedPaymentMethod ?? false;
  const fromMandate = body?.mandates
    .flatMap((m) => m.products)
    .find((p) => p.listingSlug)?.listingSlug;
  const fromOptions = body?.productOptions.find((p) => p.listingSlug)?.listingSlug;
  return {
    savedCard,
    mandate: best,
    ready: savedCard && best !== null,
    offerSlug: fromMandate ?? fromOptions ?? DEMO_OFFER_SLUG,
  };
}

/** "3 min ago" style, for the token table's last-used column. */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never';
  const sec = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'Just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** W19 tool row input, from the live `tools/list` params: `{ listingSlug, amountCents? }`. */
export function toolSignature(params: readonly McpToolParam[]): string {
  if (params.length === 0) return '{}';
  return `{ ${params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')} }`;
}

/** W19 mandates card row (Figma 115:184): "Up to $250" · "Cap $600 · Aurel A7 · expires Dec 1". */
export function mandateSummary(m: MandateView): { title: string; detail: string } {
  const products =
    m.products.length === 0
      ? 'Any product'
      : m.products.length === 1
        ? (m.products[0]!.title ?? '1 product')
        : `${m.products.length} products`;
  const parts = [`Cap ${formatUsd(m.totalHoldCapCents)}`, products];
  if (m.expiresAt) {
    const d = new Date(m.expiresAt);
    parts.push(
      `expires ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`,
    );
  }
  return { title: `Up to ${formatUsd(m.maxPriceCents)}`, detail: parts.join(' · ') };
}
