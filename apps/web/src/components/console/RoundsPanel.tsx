import { useId, useRef, useState } from 'react';
import type { ListingPhaseName, RoundsState } from '@holdfast/shared';
import type { ApiRequest } from '../../lib/api';
import { formatDeadline } from '../../lib/console/phase';
import {
  parseTargetQuantity,
  roundHeader,
  roundsPanelMode,
  startConfirmCopy,
  startPreview,
  stopClearBy,
  type RoundsListing,
} from '../../lib/console/rounds';
import {
  EMPTY_FEED,
  END_REASON_COPY,
  endedCopy,
  extensionCopy,
  recentExtension,
  type RoundsFeed as Feed,
} from '../../lib/console/rounds-feed';
import { useSetSliderQuantity, useSlider } from '../../lib/console/slider-store';
import { useApiAction } from '../../lib/use-api-action';
import { Button, ErrorBanner } from '../ui';
import { RoundsFeed } from './RoundsFeed';

/**
 * W06 live rounds controls, basic part (HF-037a; features/19 §Screens): "Start live rounds" with a
 * target quantity and the D6/D7 confirm copy, then the round header (round N, "ends in mm:ss",
 * overall end), inline target edit, "Next round" and "Stop". OWNER/MANAGER only: a VIEWER sees the
 * round header without controls (and the API refuses them, and every agent, with 403). Clear stays
 * HF-028's button, which reads "Stop rounds & clear" during rounds.
 *
 * Full part (HF-037b): the raises feed with per-round summaries, a short "+10 min (late raise)"
 * note when soft close moves the timer, and the end reason once rounds end.
 */

type Action = ReturnType<typeof useApiAction<RoundsState>>;

/** One click is one action: a fresh Idempotency-Key, unless retrying a retryable failure. */
function runOnce(action: Action, req: ApiRequest): Promise<RoundsState | undefined> {
  if (!(action.status === 'error' && action.error.retryable)) action.reset();
  return action.run(req);
}

const roundsPath = (listingId: string, suffix = '') =>
  `/api/listings/${encodeURIComponent(listingId)}/rounds${suffix}`;

const DIALOG =
  'm-auto w-[min(480px,calc(100vw-32px))] rounded-md border border-line bg-white p-0 shadow-card backdrop:bg-ink/30';

export function RoundsPanel({
  listingId,
  listing,
  phase,
  viewer,
  now,
  feed = EMPTY_FEED,
  placement = 'card',
  onChanged,
}: {
  listingId: string;
  /** The book's listing with any newer rounds state merged in (`withRoundsOverlay`). */
  listing: RoundsListing;
  phase: ListingPhaseName;
  viewer: boolean;
  now: number;
  /** Raises feed (HF-037b, `useRoundsActivity`). */
  feed?: Feed;
  /**
   * v4 console (frame 112:64): `clear-panel` is only the "Start live rounds" button inside the Clear
   * panel; `card` is the running / ended rounds card. `all` keeps both in one card.
   */
  placement?: 'all' | 'clear-panel' | 'card';
  /** A rounds call landed (its state) or failed (no state; the view may be stale): re-read the book. */
  onChanged(state?: RoundsState): void;
}) {
  const mode = roundsPanelMode(phase, listing, viewer);
  if (mode === 'hidden') return null;
  if (placement === 'clear-panel') {
    return mode === 'start' ? (
      <StartRounds
        listingId={listingId}
        listing={listing}
        now={now}
        onChanged={onChanged}
        compact
      />
    ) : null;
  }
  if (placement === 'card' && mode === 'start') return null;
  return (
    <section
      aria-label="Live rounds"
      className="flex flex-col gap-4 rounded-md border border-line bg-white p-4"
      data-testid="rounds-panel"
    >
      {mode === 'start' ? (
        <StartRounds listingId={listingId} listing={listing} now={now} onChanged={onChanged} />
      ) : (
        <ActiveRounds
          listingId={listingId}
          listing={listing}
          now={now}
          controls={mode === 'active' && !viewer}
          ended={mode === 'ended'}
          feed={feed}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

function StartRounds({
  listingId,
  listing,
  now,
  onChanged,
  compact = false,
}: {
  listingId: string;
  listing: RoundsListing;
  now: number;
  onChanged(state?: RoundsState): void;
  /** Just the button, for the Clear panel; the target (from the slider) is set in the dialog. */
  compact?: boolean;
}) {
  const slider = useSlider();
  const setSliderQuantity = useSetSliderQuantity();
  const start = useApiAction<RoundsState>();
  const dialog = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  // Follows the slider until the brand types their own number.
  const [typed, setTyped] = useState<string | null>(null);
  const raw = typed ?? String(slider.committedQuantity ?? listing.quantity);
  const target = parseTargetQuantity(raw, listing.quantity);
  const preview = startPreview(listing, now);

  const open = () => {
    if ((!compact && !target.ok) || !preview.possible) return;
    start.reset();
    dialog.current?.showModal();
  };
  const confirm = async () => {
    if (!target.ok) return;
    const state = await runOnce(start, {
      method: 'POST',
      path: roundsPath(listingId, '/start'),
      body: { targetQuantity: target.value },
    });
    if (state) {
      dialog.current?.close();
      setSliderQuantity(target.value);
    }
    onChanged(state);
  };

  const dialogEl = (
    <dialog ref={dialog} aria-labelledby={`${inputId}-title`} className={DIALOG}>
      <div className="flex flex-col gap-4 p-6">
        <h2 id={`${inputId}-title`} className="text-[20px] font-medium tracking-headline text-ink">
          Start live rounds for {target.ok ? target.value.toLocaleString('en-US') : '…'} units?
        </h2>
        {compact && (
          <label className="flex flex-col gap-1 text-[13px] text-body">
            Target quantity
            <input
              inputMode="numeric"
              value={raw}
              onChange={(e) => setTyped(e.target.value)}
              aria-invalid={!target.ok || undefined}
              className="h-10 w-32 rounded-sm border border-border px-3 font-mono text-[14px] text-ink tabular-nums"
              data-testid="rounds-target-input"
            />
            {!target.ok && <span className="text-danger">{target.message}</span>}
          </label>
        )}
        <p className="text-[15px] leading-[22px] text-body" data-testid="rounds-start-copy">
          {startConfirmCopy(preview)}
        </p>
        {start.status === 'error' && <ErrorBanner message={start.error.message} />}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => dialog.current?.close()}>
            Not yet
          </Button>
          <Button
            variant="primary"
            onClick={confirm}
            disabled={start.status === 'pending' || !target.ok}
          >
            {start.status === 'pending' ? 'Starting…' : 'Start rounds'}
          </Button>
        </div>
      </div>
    </dialog>
  );

  if (compact) {
    return (
      <>
        <Button
          variant="outline"
          size="lg"
          block
          onClick={open}
          disabled={!preview.possible}
          title={
            preview.possible
              ? 'Give bidders under the cutoff a few short rounds to raise.'
              : 'It is too late to start live rounds.'
          }
          data-testid="rounds-start-button"
        >
          Start live rounds
        </Button>
        {dialogEl}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="label text-[11px] text-muted">Live rounds</h2>
        <p className="text-[14px] text-body">
          Tell bidders below the cutoff the real number and let them raise. Rounds run once per
          listing.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={inputId} className="flex flex-col gap-1 text-[13px] text-body">
          Target quantity
          <input
            id={inputId}
            inputMode="numeric"
            value={raw}
            onChange={(e) => setTyped(e.target.value)}
            aria-invalid={!target.ok || undefined}
            className="h-9 w-28 rounded-sm border border-border px-3 font-mono text-[14px] tabular-nums text-ink"
            data-testid="rounds-target-input"
          />
        </label>
        <Button
          variant="secondary"
          onClick={open}
          disabled={!target.ok || !preview.possible}
          title={preview.possible ? undefined : 'It is too late to start live rounds.'}
        >
          Start live rounds
        </Button>
      </div>
      {!target.ok && <p className="text-[13px] text-danger">{target.message}</p>}
      {!preview.possible && (
        <p className="text-[13px] text-body">
          It is too late to start live rounds on this listing.
        </p>
      )}
      {dialogEl}
    </>
  );
}

function ActiveRounds({
  listingId,
  listing,
  now,
  controls,
  ended,
  feed,
  onChanged,
}: {
  listingId: string;
  listing: RoundsListing;
  now: number;
  controls: boolean;
  ended: boolean;
  feed: Feed;
  onChanged(state?: RoundsState): void;
}) {
  const header = roundHeader(listing, now);
  const extension = ended ? null : recentExtension(feed, now);
  // The tick announces the end within a tick; until then a passed rounds_end_at is the time cap.
  const endReason = feed.ended
    ? endedCopy(feed.ended)
    : `Rounds ended in round ${header.round}: ${END_REASON_COPY.CAP_REACHED}.`;
  const next = useApiAction<RoundsState>();
  const stop = useApiAction<RoundsState>();
  const stopDialog = useRef<HTMLDialogElement>(null);
  const stopId = useId();

  const nextRound = async () => {
    const state = await runOnce(next, {
      method: 'POST',
      path: roundsPath(listingId, '/next'),
      body: { fromRound: header.round },
    });
    onChanged(state);
  };
  const confirmStop = async () => {
    const state = await runOnce(stop, { method: 'POST', path: roundsPath(listingId, '/stop') });
    if (state) stopDialog.current?.close();
    onChanged(state);
  };
  const error = next.status === 'error' ? next.error : null;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1" data-testid="round-header">
          <h2 className="label text-[11px] text-muted">
            {ended ? 'Live rounds · ended' : 'Live rounds'}
          </h2>
          <p className="flex flex-wrap items-baseline gap-x-3 text-ink">
            <span className="text-[22px] font-medium tracking-headline">Round {header.round}</span>
            {!ended && header.roundEndsIn && (
              <span className="font-mono text-[15px] tabular-nums" data-testid="round-ends-in">
                {header.roundEndsIn}
              </span>
            )}
            {extension && (
              <span
                className="rounded-sm bg-orange-tint px-2 py-0.5 text-[13px] text-ink"
                role="status"
                data-testid="round-extended-note"
              >
                {extensionCopy(extension)}
              </span>
            )}
            {!ended && !header.roundEndsIn && (
              <span className="text-[14px] text-body">Advances with “Next round”</span>
            )}
          </p>
          {header.roundsEnd && (
            <p className="text-[13px] text-body" data-testid="rounds-end">
              {ended
                ? `Ended ${formatDeadline(Date.parse(listing.roundsEndAt!))}`
                : header.roundsEnd}
            </p>
          )}
          {ended && (
            <p className="text-[14px] text-ink" data-testid="rounds-end-reason">
              {endReason}
            </p>
          )}
        </div>
        <TargetQuantity
          listingId={listingId}
          target={header.targetQuantity}
          max={listing.quantity}
          editable={controls}
          onChanged={onChanged}
        />
      </div>
      {controls && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button variant="secondary" onClick={nextRound} disabled={next.status === 'pending'}>
            {next.status === 'pending' ? 'Next round…' : 'Next round'}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              stop.reset();
              stopDialog.current?.showModal();
            }}
          >
            Stop rounds
          </Button>
        </div>
      )}
      {error && <ErrorBanner message={error.message} />}
      <RoundsFeed feed={feed} />
      <dialog ref={stopDialog} aria-labelledby={`${stopId}-title`} className={DIALOG}>
        <div className="flex flex-col gap-4 p-6">
          <h2 id={`${stopId}-title`} className="text-[20px] font-medium tracking-headline text-ink">
            Stop live rounds?
          </h2>
          <p className="text-[15px] leading-[22px] text-body">
            The book freezes: no more raises. Clear by {formatDeadline(stopClearBy(listing, now))}.
          </p>
          {stop.status === 'error' && <ErrorBanner message={stop.error.message} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => stopDialog.current?.close()}>
              Keep running
            </Button>
            <Button variant="secondary" onClick={confirmStop} disabled={stop.status === 'pending'}>
              {stop.status === 'pending' ? 'Stopping…' : 'Stop rounds'}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}

/** Target quantity with an inline edit (`PATCH /listings/:id/rounds`); the next round uses it. */
function TargetQuantity({
  listingId,
  target,
  max,
  editable,
  onChanged,
}: {
  listingId: string;
  target: number | null;
  max: number;
  editable: boolean;
  onChanged(state?: RoundsState): void;
}) {
  const setSliderQuantity = useSetSliderQuantity();
  const patch = useApiAction<RoundsState>();
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = useId();
  const parsed = draft === null ? null : parseTargetQuantity(draft, max);

  const save = async () => {
    if (!parsed?.ok) return;
    const state = await runOnce(patch, {
      method: 'PATCH',
      path: roundsPath(listingId),
      body: { targetQuantity: parsed.value },
    });
    if (state) {
      setDraft(null);
      setSliderQuantity(parsed.value);
    }
    onChanged(state);
  };

  if (draft === null) {
    return (
      <div className="flex items-center gap-2 text-[14px] text-body">
        <span>
          Target{' '}
          <span className="font-mono text-ink tabular-nums" data-testid="rounds-target">
            {target === null ? '—' : target.toLocaleString('en-US')}
          </span>{' '}
          units
        </span>
        {editable && (
          <Button
            variant="ghost"
            onClick={() => {
              patch.reset();
              setDraft(String(target ?? max));
            }}
          >
            Edit
          </Button>
        )}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="text-[13px] text-body">
          Target units
        </label>
        <input
          id={inputId}
          inputMode="numeric"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={parsed?.ok === false || undefined}
          className="h-9 w-24 rounded-sm border border-border px-3 font-mono text-[14px] tabular-nums text-ink"
          data-testid="rounds-target-edit"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={!parsed?.ok || patch.status === 'pending'}
        >
          {patch.status === 'pending' ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
      {parsed?.ok === false && <p className="text-[13px] text-danger">{parsed.message}</p>}
      {patch.status === 'error' && <ErrorBanner message={patch.error.message} />}
    </form>
  );
}
