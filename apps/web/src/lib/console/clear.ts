import {
  BANK_PENDING_NOTE,
  feeCents,
  formatUsd,
  liquidationCents,
  recoveryMultiple,
  winnersChargedLine,
  type ClearListingResponse,
  type ClearNumbers,
  type SimulateResponse,
} from '@holdfast/shared';
import { ApiAction, ApiError, type ApiClient } from '../api';

/**
 * The W07 Clear flow (HF-028, features/08 §Layout 7, M12). No React: `useClear()` wraps it for
 * the console and HF-061's M10 sheet reuses the same flow.
 *
 *   open ─(ROUNDS: rounds/stop)→ simulate → ready ─confirm→ 202 → W08
 *                                              └─ 409 BOOK_CHANGED → book_changed ─confirm→ …
 *                                              └─ 409 NOT_CLEARABLE (CLEARING…) → W08
 *                                              └─ HOLDS_TOO_OLD → "Release all" (cancel)
 *
 * The numbers on screen are the server's `/simulate` (the exact `loadClearInput` + `clear()` the
 * Clear transaction runs, incl. aged-hold exclusion), and Confirm sends the gross on screen as
 * `expectedGrossCents`. One `ApiAction` per flow: a retry after a lost response (network, 5xx,
 * 409 IN_PROGRESS) reuses the Idempotency-Key, so the server replays its stored 202.
 */

export type ClearStep =
  | 'closed'
  /** `POST rounds/stop` in flight ("Stop rounds & clear"). */
  | 'stopping'
  /** `GET simulate` in flight. */
  | 'loading'
  /** Numbers shown; Confirm waits for the typed `CLEAR <Q>`. */
  | 'ready'
  | 'submitting'
  /** 409 BOOK_CHANGED: new numbers on screen; one-click "Confirm $X". */
  | 'book_changed'
  /** A winner's hold is ≥ 66 h old: Clear is refused; offer "Release all". */
  | 'holds_too_old'
  /** 409 NOT_CLEARABLE for a listing that was never cleared (cancelled, expired …). */
  | 'not_clearable'
  | 'error'
  | 'releasing'
  | 'released'
  /** Cleared (202, or a lost success found as NOT_CLEARABLE + CLEARING onward): go to W08. */
  | 'cleared';

export type ClearStage = 'stop' | 'simulate' | 'clear' | 'release';

export interface ClearState {
  step: ClearStep;
  listingId: string | null;
  /** The quantity the brand is clearing (the slider's committed quantity). */
  quantity: number | null;
  /** The numbers on screen. */
  summary: SimulateResponse | null;
  /** What Confirm sends as `expectedGrossCents` (= `summary.grossCents`). */
  expectedGrossCents: number | null;
  /** BOOK_CHANGED: the gross the brand had confirmed before the book moved. */
  previousGrossCents: number | null;
  /** NOT_CLEARABLE: the listing's status. */
  listingStatus: string | null;
  /** HOLDS_TOO_OLD: winners whose hold is too old to capture. */
  agedBidIds: string[];
  error: ApiError | null;
  /** Which call failed; `retry()` repeats it. */
  failedStage: ClearStage | null;
  result: ClearListingResponse | null;
}

export interface OpenClear {
  listingId: string;
  quantity: number;
  /** ROUNDS_ACTIVE: "Stop rounds & clear" freezes the book first (D7). */
  stopRounds?: boolean;
}

/** Listing statuses that mean "already cleared": a NOT_CLEARABLE here is a lost success. */
export const CLEARED_STATUSES: ReadonlySet<string> = new Set([
  'CLEARING',
  'SETTLED',
  'PAID_OUT',
  'PAYOUT_FAILED',
]);

const CLOSED: ClearState = {
  step: 'closed',
  listingId: null,
  quantity: null,
  summary: null,
  expectedGrossCents: null,
  previousGrossCents: null,
  listingStatus: null,
  agedBidIds: [],
  error: null,
  failedStage: null,
  result: null,
};

export interface ClearFlow {
  get(): ClearState;
  subscribe(fn: () => void): () => void;
  open(input: OpenClear): Promise<void>;
  /** Clear at `expectedGrossCents` (first confirm, the one-click BOOK_CHANGED confirm, a retry). */
  confirm(): Promise<void>;
  /** Repeat the call that failed (same Idempotency-Key when it was retryable). */
  retry(): Promise<void>;
  /** HOLDS_TOO_OLD: cancel the window, releasing every hold (HF-012b; OPEN or ROUNDS). */
  releaseAll(): Promise<void>;
  close(): void;
}

const asApiError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');

const listingPath = (id: string, tail: string) => `/api/listings/${encodeURIComponent(id)}/${tail}`;

export function createClearFlow(client: ApiClient, mintKey?: () => string): ClearFlow {
  let state: ClearState = CLOSED;
  const subs = new Set<() => void>();
  /** Bumped by open/close: answers for an earlier modal are dropped. */
  let generation = 0;
  // One action per kind of call, kept across close/reopen so a retried Clear keeps its key.
  const clearAction = new ApiAction(client, mintKey);
  const stopAction = new ApiAction(client, mintKey);
  const releaseAction = new ApiAction(client, mintKey);

  const publish = (patch: Partial<ClearState>) => {
    state = { ...state, ...patch };
    subs.forEach((fn) => fn());
  };

  const fail = (stage: ClearStage, err: unknown) =>
    publish({ step: 'error', error: asApiError(err), failedStage: stage });

  const conflictReason = (err: ApiError) =>
    err.status === 409 && err.code === 'STATE_CONFLICT' ? String(err.details.reason ?? '') : null;

  /** The listing is already clearing or cleared: a lost success. Hand over to W08. */
  const landOnSettlement = (status: string) =>
    publish({ step: 'cleared', listingStatus: status, error: null, failedStage: null });

  const simulate = async (gen: number, opts: { afterBookChange?: boolean } = {}) => {
    const { listingId, quantity } = state;
    if (!listingId || quantity === null) return;
    if (!opts.afterBookChange) publish({ step: 'loading', error: null, failedStage: null });
    try {
      const sim = await client.request<SimulateResponse>({
        method: 'GET',
        path: `${listingPath(listingId, 'simulate')}?quantity=${quantity}`,
      });
      if (gen !== generation) return;
      if (opts.afterBookChange) {
        // Refresh the table; stay in book_changed so the brand confirms the new gross.
        if (state.step !== 'book_changed') return;
        publish({ summary: sim, expectedGrossCents: sim.grossCents });
        return;
      }
      if (sim.holdsTooOldBidIds.length > 0) {
        publish({ step: 'holds_too_old', summary: sim, agedBidIds: sim.holdsTooOldBidIds });
        return;
      }
      publish({ step: 'ready', summary: sim, expectedGrossCents: sim.grossCents });
    } catch (err) {
      if (gen !== generation || opts.afterBookChange) return;
      fail('simulate', err);
    }
  };

  const stopRounds = async (gen: number) => {
    const { listingId } = state;
    if (!listingId) return;
    publish({ step: 'stopping', error: null, failedStage: null });
    try {
      await stopAction.run({ method: 'POST', path: listingPath(listingId, 'rounds/stop') });
    } catch (err) {
      if (gen !== generation) return;
      const e = asApiError(err);
      const reason = conflictReason(e);
      const status = String(e.details.status ?? '');
      // Already stopped (or ended on its own): the book is frozen either way, carry on.
      if (reason === 'ROUNDS_ENDED') return simulate(gen);
      if (reason === 'NOT_IN_ROUNDS') {
        if (CLEARED_STATUSES.has(status)) return landOnSettlement(status);
        if (status === 'OPEN') return simulate(gen);
      }
      return fail('stop', e);
    }
    if (gen !== generation) return;
    stopAction.reset();
    await simulate(gen);
  };

  const flow: ClearFlow = {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },

    async open({ listingId, quantity, stopRounds: stop }) {
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        throw new RangeError(`quantity must be a positive integer, got ${String(quantity)}`);
      }
      const gen = ++generation;
      state = { ...CLOSED, listingId, quantity };
      if (stop) await stopRounds(gen);
      else await simulate(gen);
    },

    async confirm() {
      const { listingId, quantity, expectedGrossCents, step } = state;
      if (!listingId || quantity === null || expectedGrossCents === null) return;
      if (step === 'submitting' || step === 'cleared') return;
      const gen = generation;
      publish({ step: 'submitting', error: null, failedStage: null });
      try {
        const result = await clearAction.run<ClearListingResponse>({
          method: 'POST',
          path: listingPath(listingId, 'clear'),
          body: { quantity, expectedGrossCents },
        });
        if (gen !== generation) return;
        clearAction.reset();
        publish({ step: 'cleared', result, listingStatus: result.status });
      } catch (err) {
        if (gen !== generation) return;
        const e = asApiError(err);
        const reason = conflictReason(e);
        if (reason === 'BOOK_CHANGED') {
          const numbers = e.details.numbers as ClearNumbers | undefined;
          if (numbers && state.summary) {
            publish({
              step: 'book_changed',
              previousGrossCents: expectedGrossCents,
              expectedGrossCents: numbers.grossCents,
              summary: withNumbers(state.summary, numbers),
            });
            // The 409 carries gross, cutoff and winners; re-read the rest (losers, liquidation).
            void simulate(gen, { afterBookChange: true });
            return;
          }
        }
        if (reason === 'NOT_CLEARABLE') {
          const status = String(e.details.status ?? '');
          if (CLEARED_STATUSES.has(status)) return landOnSettlement(status);
          return publish({ step: 'not_clearable', listingStatus: status || null, error: e });
        }
        if (reason === 'HOLDS_TOO_OLD') {
          const ids = e.details.bidIds;
          return publish({
            step: 'holds_too_old',
            agedBidIds: Array.isArray(ids) ? ids.map(String) : [],
          });
        }
        fail('clear', e);
      }
    },

    async retry() {
      const gen = generation;
      switch (state.failedStage) {
        case 'stop':
          return stopRounds(gen);
        case 'simulate':
          return simulate(gen);
        case 'clear':
          return flow.confirm();
        case 'release':
          return flow.releaseAll();
      }
    },

    async releaseAll() {
      const { listingId } = state;
      if (!listingId || state.step === 'releasing') return;
      const gen = generation;
      publish({ step: 'releasing', error: null, failedStage: null });
      try {
        await releaseAction.run({ method: 'POST', path: listingPath(listingId, 'cancel') });
        if (gen !== generation) return;
        releaseAction.reset();
        publish({ step: 'released' });
      } catch (err) {
        if (gen !== generation) return;
        fail('release', err);
      }
    },

    close() {
      generation++;
      state = CLOSED;
      subs.forEach((fn) => fn());
    },
  };
  return flow;
}

/** A simulate summary with the 409's recomputed gross, cutoff and winners (fee from shared code). */
export function withNumbers(sim: SimulateResponse, n: ClearNumbers): SimulateResponse {
  const fee = feeCents(n.grossCents, sim.feeBps);
  const quote =
    sim.liquidationCents !== null && sim.winners > 0 ? sim.liquidationCents / sim.winners : null;
  const liquidation = liquidationCents(n.winners, quote);
  return {
    ...sim,
    cutoffCents: n.cutoffCents,
    grossCents: n.grossCents,
    winners: n.winners,
    losers: Math.max(0, sim.winners + sim.losers - n.winners),
    averageWinningCents: n.winners ? Math.round(n.grossCents / n.winners) : null,
    feeCents: fee,
    netCents: n.grossCents - fee,
    liquidationCents: liquidation,
    recoveryMultiple: recoveryMultiple(n.grossCents, liquidation),
    bookVersion: n.bookVersion,
  };
}

// --- Copy and the typed confirm ------------------------------------------------------------

/** The phrase the brand types: `CLEAR 240`. */
export function confirmPhrase(quantity: number): string {
  return `CLEAR ${quantity}`;
}

/** Case and spacing don't matter; the number does. */
export function isConfirmTyped(typed: string, quantity: number): boolean {
  return typed.trim().replace(/\s+/g, ' ').toUpperCase() === confirmPhrase(quantity);
}

/**
 * The plain-English line (D14, pre-capture): "Each winner will be charged their own bid (lowest
 * $219, average $226). Everyone else's hold is released. Your bank may show it as pending for a
 * few days." Pay-your-bid only: never one price for every winner.
 */
export function clearCopy(
  sim: Pick<SimulateResponse, 'winners' | 'losers' | 'cutoffCents' | 'grossCents'>,
): string {
  if (sim.winners < 1 || sim.cutoffCents === null) return 'No bid would win at this quantity.';
  const charged = winnersChargedLine(
    { winners: sim.winners, lowestCents: sim.cutoffCents, grossCents: sim.grossCents },
    { preCapture: true },
  );
  return sim.losers > 0
    ? `${charged} Everyone else's hold is released. ${BANK_PENDING_NOTE}`
    : charged;
}

/** "Only 230 eligible bids will clear", shown above the input when winners < Q; else null. */
export function shortfallNote(quantity: number, winners: number): string | null {
  if (winners >= quantity) return null;
  if (winners === 1) return 'Only 1 eligible bid will clear.';
  return `Only ${winners.toLocaleString('en-US')} eligible bids will clear.`;
}

/** "$54.0k" for the BOOK_CHANGED banner and the one-click button (exact under $1,000). */
export function formatGrossShort(cents: number): string {
  if (Math.abs(cents) < 100_000) return formatUsd(cents);
  const dollars = cents / 100;
  if (Math.abs(dollars) < 1_000_000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${(dollars / 1_000_000).toFixed(2)}M`;
}
