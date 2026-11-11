import {
  BRAND_AGENT_WIDGETS,
  BRAND_AGENT_WIDGET_TITLES,
  recommendationReasons,
  type BookResponse,
  type SimulateResponse,
} from '@holdfast/shared';
import type { ToolDefinition } from '../agent/model.js';
import type { Db } from '../db.js';
import { loadBook, simulateListing, SimulateQuantityError } from '../listings/book.js';

/**
 * Brand agent tools (HF-051b; features/09 §Logic 2–3, §Acceptance criteria).
 *
 * **One registry per agent context**, so no context can reach another's tools:
 * - `ask` (`POST /brand-agent/ask`, and the prose under the W06 card): three read-only book tools
 *   plus one UI tool. The UI tool is never run on the server; the browser's AG Studio panel adds
 *   the widget to the brand's own dashboard. Nothing in `ask` writes a row, moves money or clears.
 * - `nudge` (live rounds, HF-036a/b): `send_nudge(bidId)` only, called by the round runner with
 *   numbers from code (features/09 §Purpose). The model never calls it.
 *
 * The buyer agent's tools (HF-039, `agent/tools.ts`) are a third, separate registry.
 */

/** `read`: reads the book. `ui`: changes only the brand's own screen. `write`: changes state. */
export type BrandToolEffect = 'read' | 'ui' | 'write';

export interface BrandToolEntry {
  name: string;
  effect: BrandToolEffect;
  /** Who runs it: this server, the browser (AG Studio), or the round runner (never the model). */
  runBy: 'server' | 'browser' | 'round_runner';
  definition: ToolDefinition;
}

const noInput = { type: 'object', properties: {}, additionalProperties: false };

export const GET_BOOK_SUMMARY: BrandToolEntry = {
  name: 'get_book_summary',
  effect: 'read',
  runBy: 'server',
  definition: {
    name: 'get_book_summary',
    description:
      'Read the live book for this listing: product, quantity, floor, public low price, liquidation quote, fee, held bids and dollars (with the simulated share), held dollars by bid source, and bids in $10 price bands. All amounts are integer cents.',
    input_schema: noInput,
  },
};

export const SIMULATE_CLEAR: BrandToolEntry = {
  name: 'simulate_clear',
  effect: 'read',
  runBy: 'server',
  definition: {
    name: 'simulate_clear',
    description:
      'What clearing exactly `quantity` units would do now, computed by the same code Clear uses: cutoff (lowest winning bid), winners, losers, gross, fee, net, liquidation comparison and recovery multiple. Read-only: it never clears. Amounts are integer cents.',
    input_schema: {
      type: 'object',
      properties: {
        quantity: { type: 'integer', minimum: 1, description: 'Units to clear.' },
      },
      required: ['quantity'],
      additionalProperties: false,
    },
  },
};

export const GET_RECOMMENDATION: BrandToolEntry = {
  name: 'get_recommendation',
  effect: 'read',
  runBy: 'server',
  definition: {
    name: 'get_recommendation',
    description:
      "Holdfast's code-computed recommendation: the quantity with the highest net recovery whose cutoff stays at or above max(floor, the brand's max-discount guard), with up to two alternatives and the reasons. Amounts are integer cents.",
    input_schema: noInput,
  },
};

export const ADD_CONSOLE_WIDGET: BrandToolEntry = {
  name: 'add_console_widget',
  effect: 'ui',
  runBy: 'browser',
  definition: {
    name: 'add_console_widget',
    description: `Add a chart widget to the brand's agent dashboard in the console. Only when the brand asks for a chart or widget. Kinds: ${BRAND_AGENT_WIDGETS.map((k) => `${k} ("${BRAND_AGENT_WIDGET_TITLES[k]}")`).join(', ')}. It changes only the brand's screen.`,
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: [...BRAND_AGENT_WIDGETS] } },
      required: ['kind'],
      additionalProperties: false,
    },
  },
};

export const SEND_NUDGE: BrandToolEntry = {
  name: 'send_nudge',
  effect: 'write',
  runBy: 'round_runner',
  definition: {
    name: 'send_nudge',
    description:
      "Send this round's nudge to one below-cutoff bid (rounds/nudges.ts `sendNudge`). Called by the round runner with numbers from code.",
    input_schema: {
      type: 'object',
      properties: { bidId: { type: 'string' } },
      required: ['bidId'],
      additionalProperties: false,
    },
  },
};

export type BrandAgentContext = 'ask' | 'nudge';

/** The per-context registries. Frozen: a context's tool list is decided here, nowhere else. */
export const BRAND_AGENT_REGISTRIES: Readonly<
  Record<BrandAgentContext, readonly BrandToolEntry[]>
> = Object.freeze({
  ask: Object.freeze([GET_BOOK_SUMMARY, SIMULATE_CLEAR, GET_RECOMMENDATION, ADD_CONSOLE_WIDGET]),
  nudge: Object.freeze([SEND_NUDGE]),
});

/** The tool definitions the model sees in a context (`explain` mode drops the widget tool). */
export function brandToolDefinitions(
  context: BrandAgentContext,
  opts: { widgets?: boolean } = {},
): ToolDefinition[] {
  return BRAND_AGENT_REGISTRIES[context]
    .filter((t) => t.runBy !== 'round_runner')
    .filter((t) => opts.widgets !== false || t.effect !== 'ui')
    .map((t) => t.definition);
}

// --- Running the read tools -------------------------------------------------------------------

/** The book reads the ask tools need, scoped to the brand in the session. */
export interface BookReader {
  book(brandId: string, listingId: string): Promise<BookResponse>;
  simulate(brandId: string, listingId: string, quantity: number): Promise<SimulateResponse>;
}

export function dbBookReader(db: Db): BookReader {
  return {
    book: (brandId, listingId) => loadBook(db, brandId, listingId),
    simulate: (brandId, listingId, quantity) => simulateListing(db, brandId, listingId, quantity),
  };
}

const BAND_CENTS = 1_000;
const MAX_BANDS = 20;

/** `get_book_summary`'s JSON: brand-only facts (the floor included: this is the brand's session). */
export function bookSummary(book: BookResponse) {
  const { listing, stats } = book;
  const bySource = new Map<string, { bids: number; heldCents: number }>();
  const bands = new Map<number, { bids: number; heldCents: number }>();
  for (const b of book.bids) {
    const source = b.isSimulated ? 'SIM' : (b.source ?? 'UNKNOWN');
    const s = bySource.get(source) ?? { bids: 0, heldCents: 0 };
    s.bids += 1;
    s.heldCents += b.amountCents;
    bySource.set(source, s);
    const from = Math.floor(b.amountCents / BAND_CENTS) * BAND_CENTS;
    const band = bands.get(from) ?? { bids: 0, heldCents: 0 };
    band.bids += 1;
    band.heldCents += b.amountCents;
    bands.set(from, band);
  }
  const amounts = book.bids.map((b) => b.amountCents);
  return {
    product: listing.product.title,
    status: listing.status,
    phase: listing.phase,
    quantity: listing.quantity,
    floorCents: listing.floorCents,
    publicLowCents: listing.priceWatch.bestPublicPriceCents,
    publicLowMerchant: listing.priceWatch.merchant,
    liquidationQuoteCents: listing.liquidationQuoteCents,
    feeBps: listing.feeBps,
    windowClosesAt: listing.windowClosesAt,
    clearByAt: listing.clearByAt,
    liveBids: stats.liveBids,
    heldCents: stats.heldCents,
    simulatedHeldCents: stats.simulatedHeldCents,
    bidsAtOrAboveFloor: book.bids.filter((b) => !b.belowFloor).length,
    highestBidCents: amounts.length ? Math.max(...amounts) : null,
    lowestBidCents: amounts.length ? Math.min(...amounts) : null,
    pendingBids: book.pending.length,
    releasedByPriceWatch: stats.releasedByPriceWatch,
    heldBySource: [...bySource]
      .map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.heldCents - a.heldCents),
    // Highest bands first; the long tail below them is summed into one row.
    priceBands: (() => {
      const sorted = [...bands]
        .sort((a, b) => b[0] - a[0])
        .map(([from, v]) => ({ fromCents: from, toCents: from + BAND_CENTS - 1, ...v }));
      if (sorted.length <= MAX_BANDS) return sorted;
      const rest = sorted.slice(MAX_BANDS - 1);
      return [
        ...sorted.slice(0, MAX_BANDS - 1),
        {
          fromCents: rest[rest.length - 1]!.fromCents,
          toCents: rest[0]!.toCents,
          bids: rest.reduce((n, r) => n + r.bids, 0),
          heldCents: rest.reduce((n, r) => n + r.heldCents, 0),
        },
      ];
    })(),
    bookVersion: book.bookVersion,
  };
}

/** `get_recommendation`'s JSON: HF-051a's recommendation plus code-written reasons. */
export function recommendationResult(book: BookResponse) {
  const rec = book.recommendation;
  if (!rec) return { kind: 'NO_DEMAND', reasons: ['Not enough demand yet; share your link.'] };
  return { ...rec, reasons: recommendationReasons(rec) };
}

/** `simulate_clear`'s JSON: `/simulate` without the per-bid id lists (counts instead). */
export function simulateResult(s: SimulateResponse) {
  const { winnerBidIds: _w, holdsTooOldBidIds, ...rest } = s;
  return { ...rest, holdsTooOld: holdsTooOldBidIds.length };
}

export interface ToolOutcome {
  result: Record<string, unknown>;
  isError: boolean;
}

const toolError = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  result: { error: { code, message, ...extra } },
  isError: true,
});

/**
 * Run one `ask` server tool. The UI tool and anything outside the `ask` registry are refused:
 * the model can only reach what the registry lists.
 */
export async function runAskTool(
  reader: BookReader,
  scope: { brandId: string; listingId: string; book: BookResponse },
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  const entry = BRAND_AGENT_REGISTRIES.ask.find((t) => t.name === name);
  if (!entry || entry.runBy !== 'server') {
    return toolError('UNKNOWN_TOOL', `No tool named ${name} here.`);
  }
  switch (name) {
    case 'get_book_summary':
      return { result: bookSummary(scope.book), isError: false };
    case 'get_recommendation':
      return { result: recommendationResult(scope.book), isError: false };
    case 'simulate_clear': {
      const q = (input as { quantity?: unknown } | null)?.quantity;
      if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 1) {
        return toolError('VALIDATION_ERROR', 'quantity must be a whole number of at least 1.');
      }
      try {
        return {
          result: simulateResult(await reader.simulate(scope.brandId, scope.listingId, q)),
          isError: false,
        };
      } catch (err) {
        if (err instanceof SimulateQuantityError) {
          return toolError('VALIDATION_ERROR', err.message, { maxQuantity: err.maxQuantity });
        }
        throw err;
      }
    }
  }
  return toolError('UNKNOWN_TOOL', `No tool named ${name} here.`);
}
