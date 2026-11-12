import { useEffect, useRef } from 'react';
import { formatUsd, type BookResponse } from '@holdfast/shared';
import { Badge, Button, ButtonLink, ErrorBanner, Skeleton, useToast } from '../../components/ui';
import { PriceWatchPausedBanner } from '../../components/PriceWatchPausedBanner';
import { api } from '../../lib/api';
import type { PhaseView } from '../../lib/console/phase';
import { shareSummary, type ShareStats } from '../../lib/embed';
import { paths } from '../../lib/routes';
import { useApiAction } from '../../lib/use-api-action';

/**
 * W06 header (HF-023, features/08 §Layout 1): product, status pill + deadline from the shared
 * `listingPhase()`, public low + price-watch state, Share offer link, Cancel window.
 */
export function ConsoleHeader({
  book,
  phase,
  readOnly,
  onCancelled,
}: {
  book: BookResponse | null;
  phase: PhaseView | null;
  /** VIEWER: no Cancel. */
  readOnly: boolean;
  onCancelled(): void;
}) {
  const listing = book?.listing;
  return (
    <header className="flex flex-col gap-5 border-b border-line pt-8 pb-6 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 gap-4">
        <ProductImage url={listing?.product.imageUrl ?? null} loading={!listing} />
        <div className="flex min-w-0 flex-col gap-2">
          {listing ? (
            <h1 className="text-[26px] leading-[1.15] font-medium tracking-headline text-ink sm:text-[32px]">
              {listing.product.title ?? 'Untitled product'}
            </h1>
          ) : (
            <Skeleton className="h-8 w-72" />
          )}
          {phase && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Badge tone={phase.tone} className="uppercase" title={phase.phase}>
                {phase.pill}
              </Badge>
              {phase.deadline && (
                <span
                  className="font-mono text-[13px] text-body tabular-nums"
                  data-testid="phase-deadline"
                >
                  {phase.deadline}
                </span>
              )}
            </div>
          )}
          {listing && <PriceWatch book={book!} />}
        </div>
      </div>
      {listing && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {!phase?.locked && <ShareButton listingId={listing.id} slug={listing.slug} />}
          {!phase?.locked && listing.slug && (
            <ButtonLink variant="outline" to={paths.brandEmbed}>
              Embed
            </ButtonLink>
          )}
          {!readOnly && phase && (
            <CancelWindow
              listingId={listing.id}
              holds={book!.stats.liveBids}
              enabled={phase.cancellable}
              onCancelled={onCancelled}
            />
          )}
        </div>
      )}
    </header>
  );
}

function ProductImage({ url, loading }: { url: string | null; loading: boolean }) {
  if (loading) return <Skeleton className="size-16 shrink-0 sm:size-20" />;
  return url ? (
    <img
      src={url}
      alt=""
      className="size-16 shrink-0 rounded-md border border-line object-contain sm:size-20"
    />
  ) : (
    <div
      aria-hidden
      className="size-16 shrink-0 rounded-md border border-line bg-surface sm:size-20"
    />
  );
}

function PriceWatch({ book }: { book: BookResponse }) {
  const pw = book.listing.priceWatch;
  // HF-042b: Channel3 unreachable → the watch is paused even with a subscription.
  const on = pw.on && !pw.pausedAt;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-body">
        {pw.bestPublicPriceCents !== null && (
          <Badge tone="neutral">
            Public low {formatUsd(pw.bestPublicPriceCents)}
            {pw.merchant ? ` · ${pw.merchant}` : ''}
          </Badge>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={on ? 'size-1.5 rounded-full bg-success' : 'size-1.5 rounded-full bg-muted'}
          />
          Price watch {on ? 'on' : 'paused'}
        </span>
      </div>
      {pw.pausedAt && <PriceWatchPausedBanner />}
    </div>
  );
}

export function offerUrl(slug: string): string {
  return `${window.location.origin}${paths.offer(slug)}`;
}

/**
 * Share offer link (W06): reads `GET /api/listings/:id/share` for the live slug and how shared links
 * are doing, copies the link and says so. The share read failing never blocks the copy.
 */
export function ShareButton({
  listingId,
  slug,
  variant = 'outline',
}: {
  listingId: string;
  slug: string | null;
  variant?: 'outline' | 'primary';
}) {
  const toast = useToast();
  if (!slug) return null;
  const copy = async () => {
    const stats = await api
      .request<ShareStats>({
        method: 'GET',
        path: `/api/listings/${encodeURIComponent(listingId)}/share`,
      })
      .catch(() => null);
    const url = offerUrl(stats?.slug ?? slug);
    const summary = stats ? shareSummary(stats) : null;
    try {
      await navigator.clipboard.writeText(url);
      toast.show({
        title: 'Offer link copied',
        body: summary ? `${url} · ${summary}` : url,
        tone: 'success',
      });
    } catch {
      toast.show({ title: 'Copy this offer link', body: url, duration: 0 });
    }
  };
  return (
    <Button variant={variant} onClick={copy}>
      Share offer link
    </Button>
  );
}

/**
 * Cancel window → HF-012b `POST /api/listings/:id/cancel` (async: 202, holds void in the
 * background). Allowed from OPEN and ROUNDS; disabled from CLEARING onward.
 */
function CancelWindow({
  listingId,
  holds,
  enabled,
  onCancelled,
}: {
  listingId: string;
  holds: number;
  enabled: boolean;
  onCancelled(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useApiAction<{ status: string }>();
  const toast = useToast();

  useEffect(() => {
    if (!enabled) dialog.current?.close();
  }, [enabled]);

  const open = () => {
    cancel.reset();
    dialog.current?.showModal();
  };
  const confirm = async () => {
    const res = await cancel.run({
      method: 'POST',
      path: `/api/listings/${encodeURIComponent(listingId)}/cancel`,
    });
    if (res) {
      dialog.current?.close();
      toast.show({ title: 'Window cancelled', body: 'Releasing every hold now.' });
      onCancelled();
    }
  };
  const n = holds.toLocaleString('en-US');

  return (
    <>
      <Button
        variant="ghost"
        onClick={open}
        disabled={!enabled}
        title={enabled ? undefined : 'The window can no longer be cancelled.'}
      >
        Cancel window
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="cancel-title"
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-md border border-line bg-white p-0 shadow-card backdrop:bg-ink/30"
      >
        <div className="flex flex-col gap-4 p-6">
          <h2 id="cancel-title" className="text-[20px] font-medium tracking-headline text-ink">
            Cancel this window?
          </h2>
          <p className="text-[15px] leading-[22px] text-body">
            {holds === 1 ? '1 hold will be released.' : `${n} holds will be released.`} Shoppers'
            banks may show them as pending for a few days.
          </p>
          {cancel.status === 'error' && <ErrorBanner message={cancel.error.message} />}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => dialog.current?.close()}>
              Keep window open
            </Button>
            <Button variant="secondary" onClick={confirm} disabled={cancel.status === 'pending'}>
              {cancel.status === 'pending' ? 'Cancelling…' : 'Cancel window'}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
