import {
  formatUsd,
  type ListingEvent,
  type RoundEndReason,
  type RoundsActivity,
  type RoundsActivityEnded,
  type RoundsActivityExtension,
  type RoundsActivityRaise,
  type RoundsActivityRound,
} from '@holdfast/shared';

/**
 * Live rounds console, full part (HF-037b; features/19 §Screens, screens.md W06): the raises feed,
 * the per-round summary, the "+10 min (late raise)" note and the end reason. Pure, no React.
 *
 * Two sources, merged:
 * - the server's `GET /listings/:id/rounds/activity`, re-read on every `bid.raised` / `round.*`
 *   notice (SSE notices carry ids only, HF-008). It is the truth whenever it answers;
 * - full `ListingEvent`s from the HF-036a fixture replay, folded in locally so the console shows a
 *   replayed round without a matching database. They never carry gross numbers.
 */

export interface RoundsFeed {
  /** Newest first. */
  raises: RoundsActivityRaise[];
  /** Oldest first. */
  rounds: RoundsActivityRound[];
  /** Newest first. */
  extensions: RoundsActivityExtension[];
  ended: RoundsActivityEnded | null;
  /** Replay bookkeeping: nudged bids per round, last known round end per round. */
  nudgedBids: Record<number, string[]>;
  roundEndsAt: Record<number, string>;
}

export const EMPTY_FEED: RoundsFeed = {
  raises: [],
  rounds: [],
  extensions: [],
  ended: null,
  nudgedBids: {},
  roundEndsAt: {},
};

/** The feed shows at most this many rows. */
export const FEED_MAX_ROWS = 100;
/** How long the "+10 min (late raise)" note stays next to the timer. */
export const EXTENSION_NOTE_MS = 15_000;

export function feedFromActivity(a: RoundsActivity): RoundsFeed {
  return {
    ...EMPTY_FEED,
    raises: a.raises,
    rounds: a.rounds,
    extensions: a.extensions,
    ended: a.ended,
  };
}

const byAtDesc = (x: { at: string }, y: { at: string }) => Date.parse(y.at) - Date.parse(x.at);
const extensionKey = (e: Pick<RoundsActivityExtension, 'round' | 'roundEndsAt'>) =>
  `${e.round}|${Date.parse(e.roundEndsAt)}`;

function upsertRound(
  rounds: RoundsActivityRound[],
  round: number,
  patch: (r: RoundsActivityRound) => RoundsActivityRound,
  startedAt: string | null = null,
): RoundsActivityRound[] {
  const found = rounds.find((r) => r.round === round);
  const base: RoundsActivityRound = found ?? {
    round,
    startedAt,
    nudged: 0,
    raised: 0,
    grossAtStartCents: null,
    grossDeltaCents: null,
  };
  const next = patch(base);
  return found
    ? rounds.map((r) => (r.round === round ? next : r))
    : [...rounds, next].sort((a, b) => a.round - b.round);
}

const currentRound = (feed: RoundsFeed) => feed.rounds.at(-1)?.round ?? 1;

/** Fold one full event (fixture replay) into the feed. Other events leave it unchanged. */
export function applyFeedEvent(feed: RoundsFeed, event: ListingEvent): RoundsFeed {
  switch (event.type) {
    case 'round.started': {
      const rounds = upsertRound(feed.rounds, event.round, (r) => r, event.at);
      const known = feed.roundEndsAt[event.round];
      // A round's end only moves forward (soft close); a replayed start must not rewind it.
      const keep =
        !event.roundEndsAt || (known && Date.parse(known) >= Date.parse(event.roundEndsAt));
      return {
        ...feed,
        rounds,
        roundEndsAt: keep
          ? feed.roundEndsAt
          : { ...feed.roundEndsAt, [event.round]: event.roundEndsAt! },
      };
    }
    case 'round.nudged': {
      const seen = feed.nudgedBids[event.round] ?? [];
      if (seen.includes(event.bidId)) return feed;
      return {
        ...feed,
        nudgedBids: { ...feed.nudgedBids, [event.round]: [...seen, event.bidId] },
        rounds: upsertRound(feed.rounds, event.round, (r) => ({ ...r, nudged: r.nudged + 1 })),
      };
    }
    case 'bid.raised': {
      if (feed.raises.some((r) => r.bidId === event.bidId)) return feed;
      const round = currentRound(feed);
      const raise: RoundsActivityRaise = {
        bidId: event.bidId,
        replacesBidId: event.replacesBidId,
        oldCents: event.oldCents,
        newCents: event.newCents,
        shopperLabel: event.shopperLabel,
        source: event.source,
        isSimulated: event.isSimulated,
        at: event.at,
        round,
      };
      return {
        ...feed,
        raises: [raise, ...feed.raises].sort(byAtDesc),
        rounds: upsertRound(feed.rounds, round, (r) => ({ ...r, raised: r.raised + 1 })),
      };
    }
    case 'round.extended': {
      if (feed.extensions.some((e) => extensionKey(e) === extensionKey(event))) return feed;
      const before = feed.roundEndsAt[event.round];
      const ext: RoundsActivityExtension = {
        round: event.round,
        at: event.at,
        bidId: '',
        roundEndsAt: event.roundEndsAt,
        extendedByMs: before ? Math.max(0, Date.parse(event.roundEndsAt) - Date.parse(before)) : 0,
      };
      return {
        ...feed,
        extensions: [ext, ...feed.extensions].sort(byAtDesc),
        roundEndsAt: { ...feed.roundEndsAt, [event.round]: event.roundEndsAt },
      };
    }
    case 'round.ended':
      return feed.ended
        ? feed
        : { ...feed, ended: { round: event.round, reason: event.reason, at: event.at } };
    default:
      return feed;
  }
}

/** The server's feed, plus anything only the replay has shown. The server wins on overlap. */
export function mergeFeeds(server: RoundsFeed | null, local: RoundsFeed): RoundsFeed {
  if (!server) return local;
  const raiseIds = new Set(server.raises.map((r) => r.bidId));
  const extKeys = new Set(server.extensions.map(extensionKey));
  let rounds = server.rounds;
  for (const r of local.rounds) {
    if (!rounds.some((s) => s.round === r.round)) rounds = upsertRound(rounds, r.round, () => r);
  }
  return {
    raises: [...server.raises, ...local.raises.filter((r) => !raiseIds.has(r.bidId))].sort(
      byAtDesc,
    ),
    rounds,
    extensions: [
      ...server.extensions,
      ...local.extensions.filter((e) => !extKeys.has(extensionKey(e))),
    ].sort(byAtDesc),
    ended: server.ended ?? local.ended,
    nudgedBids: local.nudgedBids,
    roundEndsAt: local.roundEndsAt,
  };
}

// --- Copy --------------------------------------------------------------------------------------

/** PayPal has no in-place increase: a raise is a new hold and a released one (features/19). */
export function raiseCopy(r: Pick<RoundsActivityRaise, 'oldCents' | 'newCents'>): string {
  return `New ${formatUsd(r.newCents)} hold placed · ${formatUsd(r.oldCents)} hold released`;
}

/** "+$1,210", "−$40", "+$0". */
export function signedUsd(cents: number): string {
  return cents < 0 ? `−${formatUsd(-cents)}` : `+${formatUsd(cents)}`;
}

/** "Round 2: nudged 14, raised 5, expected gross +$1,210". */
export function roundSummaryCopy(r: RoundsActivityRound): string {
  const parts = [`nudged ${r.nudged}`, `raised ${r.raised}`];
  if (r.grossDeltaCents !== null) parts.push(`expected gross ${signedUsd(r.grossDeltaCents)}`);
  return `Round ${r.round}: ${parts.join(', ')}`;
}

/** "10 min", "40 s" (demo time scale). */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** "+10 min (late raise)"; "(late raise)" alone when the replay could not tell how far. */
export function extensionCopy(e: Pick<RoundsActivityExtension, 'extendedByMs'>): string {
  return e.extendedByMs > 0 ? `+${formatDuration(e.extendedByMs)} (late raise)` : '(late raise)';
}

export const END_REASON_COPY: Record<RoundEndReason, string> = {
  CAP_REACHED: 'time cap reached',
  NO_RAISES: 'no raises last round',
  NONE_BELOW_CUTOFF: 'nobody below the cutoff',
  BRAND_STOPPED: 'stopped',
};

/** "Rounds ended in round 3: no raises last round." */
export function endedCopy(e: Pick<RoundsActivityEnded, 'round' | 'reason'>): string {
  return `Rounds ended in round ${e.round}: ${END_REASON_COPY[e.reason]}.`;
}

/** The extension note next to the timer, while it is recent. */
export function recentExtension(
  feed: RoundsFeed,
  now: number,
  windowMs = EXTENSION_NOTE_MS,
): RoundsActivityExtension | null {
  const latest = feed.extensions[0];
  if (!latest || feed.ended) return null;
  const at = Date.parse(latest.at);
  return now - at < windowMs && now >= at - windowMs ? latest : null;
}

// --- Feed rows ---------------------------------------------------------------------------------

export type FeedRow =
  | { kind: 'raise'; key: string; at: string; raise: RoundsActivityRaise }
  | { kind: 'extended'; key: string; at: string; extension: RoundsActivityExtension }
  | { kind: 'ended'; key: string; at: string; ended: RoundsActivityEnded };

/** Raises, extensions and the end, newest first, at most `FEED_MAX_ROWS`. */
export function feedRows(feed: RoundsFeed): FeedRow[] {
  const rows: FeedRow[] = [
    ...feed.raises.map((r) => ({
      kind: 'raise' as const,
      key: `r:${r.bidId}`,
      at: r.at,
      raise: r,
    })),
    ...feed.extensions.map((e) => ({
      kind: 'extended' as const,
      key: `x:${extensionKey(e)}`,
      at: e.at,
      extension: e,
    })),
  ];
  if (feed.ended) rows.push({ kind: 'ended', key: 'ended', at: feed.ended.at, ended: feed.ended });
  // The end sorts first on a tie; an extension sorts before the raise that caused it.
  const order = { ended: 0, extended: 1, raise: 2 } as const;
  return rows
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || order[a.kind] - order[b.kind])
    .slice(0, FEED_MAX_ROWS);
}
