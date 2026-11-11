import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { encode } from 'uqr';
import { formatUsd, type BrandListingView } from '@holdfast/shared';
import { PageHeader } from '../../components/layout/AppShell';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorBanner,
  Skeleton,
  useToast,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  conversion,
  previewPath,
  qrPath,
  shareableListings,
  shareLink,
  SOURCE_PRESETS,
  sourceFrom,
  trackedConversion,
  widgetSnippet,
  type ShareStats,
  type WidgetTheme,
} from '../../lib/embed';
import { paths } from '../../lib/routes';
import { BrandNav } from './BrandOverview';
import { useBrand } from './BrandGate';

/** Stats are counts, not a live feed: a slow re-read is enough (features/14 out of scope). */
const STATS_POLL_MS = 30_000;

/**
 * W10 embed widget & share links (HF-055; features/14, screens.md §W10): pick a listing, build a
 * tracked link (copy + QR), copy the button snippet, preview it light/dark on a labelled mock
 * store page, and read clicks, bids and held $ by source. States: listing open; closed (the
 * preview button says "Offers closed").
 */
export function EmbedPage() {
  const { me } = useBrand();
  const [listings, setListings] = useState<BrandListingView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [listingId, setListingId] = useState<string | null>(null);

  const loadListings = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.request<{ listings: BrandListingView[] }>({
        method: 'GET',
        path: '/api/listings',
      });
      const list = shareableListings(res.listings);
      setListings(list);
      setListingId((id) => id ?? list[0]?.listingId ?? null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'We could not load your listings.');
    }
  }, []);
  useEffect(() => void loadListings(), [loadListings]);

  const listing = listings?.find((l) => l.listingId === listingId) ?? null;

  return (
    <div className="flex flex-col lg:flex-row lg:gap-8">
      <BrandNav />
      <div className="min-w-0 flex-1">
        <PageHeader
          eyebrow={me.brand.name}
          title="Embed & share"
          lede="Bring your own shoppers: a tracked link for campaigns, or a “Make an offer” button for your product page."
        />
        {loadError ? (
          <ErrorBanner message={loadError} onRetry={() => void loadListings()} />
        ) : !listings ? (
          <Skeleton className="h-64 w-full" />
        ) : listings.length === 0 ? (
          <EmptyState
            message="Publish a listing to get its offer link and button."
            action={<ButtonLink to={paths.newListing}>New listing</ButtonLink>}
          />
        ) : (
          <>
            <label className="mb-8 flex max-w-[520px] flex-col gap-2">
              <span className="label text-[12px] text-muted">Listing</span>
              <select
                className="h-10 rounded-sm border border-border bg-white px-3 text-[15px] text-ink"
                value={listingId ?? ''}
                onChange={(e) => setListingId(e.target.value)}
              >
                {listings.map((l) => (
                  <option key={l.listingId} value={l.listingId}>
                    {(l.product.title ?? l.slug) + ` · ${l.status.toLowerCase()}`}
                  </option>
                ))}
              </select>
            </label>
            {listing?.slug && <ListingShare key={listing.listingId} listing={listing} />}
          </>
        )}
      </div>
    </div>
  );
}

function ListingShare({ listing }: { listing: BrandListingView }) {
  const slug = listing.slug!;
  const origin = window.location.origin;
  const stats = useShareStats(listing.listingId);
  const closed = stats.data ? !stats.data.biddable : listing.status !== 'OPEN';

  return (
    <div className="flex flex-col gap-12">
      {closed && (
        <div role="status" className="rounded-md border border-orange/30 bg-orange-tint p-4">
          <p className="text-[15px] font-medium text-ink">Offers are closed for this listing</p>
          <p className="text-[14px] text-body">
            The button shows “Offers closed” and can’t be clicked. Links still open the offer page,
            which explains the window has ended.
          </p>
        </div>
      )}
      <LinkSection origin={origin} slug={slug} />
      <ButtonSection origin={origin} slug={slug} />
      <StatsSection stats={stats} />
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-[22px] font-medium tracking-headline text-ink">{title}</h2>
        <p className="text-[14px] text-body">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function useCopy() {
  const toast = useToast();
  return async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ title: `${what} copied`, tone: 'success' });
    } catch {
      toast.show({
        title: `Couldn't copy. Select the ${what.toLowerCase()} and copy it.`,
        tone: 'error',
      });
    }
  };
}

function LinkSection({ origin, slug }: { origin: string; slug: string }) {
  const copy = useCopy();
  const [preset, setPreset] = useState<string>('email');
  const [custom, setCustom] = useState('');
  const picked = preset === 'custom' ? sourceFrom(custom) : { source: preset, error: null };
  const link = picked.source ? shareLink(origin, slug, picked.source) : null;
  const qr = useMemo(() => (link ? encode(link, { ecc: 'M', border: 2 }) : null), [link]);

  return (
    <Section
      title="Share link"
      hint="Use one source per campaign. Bids placed from the link are credited to that source."
    >
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="label mb-2 text-[12px] text-muted">Source (utm_source)</legend>
        {[...SOURCE_PRESETS, 'custom'].map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={preset === s}
            onClick={() => setPreset(s)}
            className={cn(
              'h-9 rounded-sm border px-3 font-mono text-[13px]',
              preset === s
                ? 'border-charcoal bg-charcoal text-white'
                : 'border-border bg-white text-charcoal hover:bg-surface',
            )}
          >
            {s}
          </button>
        ))}
        {preset === 'custom' && (
          <input
            aria-label="Custom source"
            aria-invalid={!!picked.error}
            placeholder="spring-email"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="h-9 w-48 rounded-sm border border-border bg-white px-3 font-mono text-[13px] text-ink"
          />
        )}
      </fieldset>
      {picked.error && preset === 'custom' && custom && (
        <p className="text-[13px] text-danger">{picked.error}</p>
      )}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex gap-2">
            <input
              readOnly
              aria-label="Share link"
              value={link ?? ''}
              onFocus={(e) => e.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 font-mono text-[13px] text-ink"
            />
            <Button
              variant="outline"
              disabled={!link}
              onClick={() => link && void copy(link, 'Link')}
            >
              Copy link
            </Button>
          </div>
          <p className="text-[13px] text-muted">
            Opens the offer page. Every visit from the link counts once per browser tab.
          </p>
        </div>
        {qr && (
          <figure className="flex shrink-0 flex-col items-center gap-2">
            <svg
              role="img"
              aria-label={`QR code for ${link}`}
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              className="h-36 w-36 rounded-sm border border-line bg-white"
              shapeRendering="crispEdges"
            >
              <path d={qrPath(qr.data)} fill="currentColor" className="text-ink" />
            </svg>
            <figcaption className="label text-[11px] text-muted">Scan to open</figcaption>
          </figure>
        )}
      </div>
    </Section>
  );
}

function ButtonSection({ origin, slug }: { origin: string; slug: string }) {
  const copy = useCopy();
  const [theme, setTheme] = useState<WidgetTheme>('light');
  const snippet = widgetSnippet(origin, slug, theme);

  return (
    <Section
      title="Make an offer button"
      hint="Paste this where the button should appear. It opens the offer page in a new tab, where shoppers sign in and hold with PayPal."
    >
      <div className="flex items-center gap-2" role="group" aria-label="Button theme">
        {(['light', 'dark'] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={theme === t}
            onClick={() => setTheme(t)}
            className={cn(
              'h-9 rounded-sm border px-3 font-mono text-[13px]',
              theme === t
                ? 'border-charcoal bg-charcoal text-white'
                : 'border-border bg-white text-charcoal hover:bg-surface',
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <pre className="overflow-x-auto rounded-sm border border-line bg-surface p-4 font-mono text-[12.5px] leading-5 text-ink">
          <code>{snippet}</code>
        </pre>
        <div>
          <Button variant="outline" onClick={() => void copy(snippet, 'Snippet')}>
            Copy snippet
          </Button>
        </div>
      </div>
      <figure className="flex flex-col gap-2">
        <figcaption className="flex items-center gap-2 text-[13px] text-muted">
          <Badge tone="sim">Mock</Badge>
          Preview on a mock Aurel Audio product page ({theme}). Not a real store.
        </figcaption>
        <iframe
          key={theme}
          title={`Button preview, ${theme}, on a mock Aurel Audio product page`}
          src={previewPath(slug, theme)}
          className="h-[560px] w-full rounded-md border border-line bg-white"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </figure>
    </Section>
  );
}

type StatsState = { data: ShareStats | null; error: string | null; retry: () => void };

function useShareStats(listingId: string): StatsState {
  const [data, setData] = useState<ShareStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(
        await api.request<ShareStats>({
          method: 'GET',
          path: `/api/listings/${encodeURIComponent(listingId)}/share`,
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'We could not load the stats.');
    }
  }, [listingId]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), STATS_POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);
  return { data, error, retry: () => void load() };
}

function StatsSection({ stats }: { stats: StatsState }) {
  const { data, error, retry } = stats;
  return (
    <Section
      title="By source"
      hint="Clicks are visits from a tracked link or the button. Bids reached a hold; held is what is held right now."
    >
      {error && !data ? (
        <ErrorBanner message={error} onRetry={retry} />
      ) : !data ? (
        <Skeleton className="h-32 w-full" />
      ) : data.sources.length === 0 ? (
        <EmptyState message="No visits or bids yet. Share the link or add the button to start counting." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left text-[14px]">
            <thead>
              <tr className="label border-b border-line text-[11px] text-muted">
                <th className="py-2 pr-4 font-normal">Source</th>
                <th className="py-2 pr-4 text-right font-normal">Clicks</th>
                <th className="py-2 pr-4 text-right font-normal">Bids</th>
                <th className="py-2 pr-4 text-right font-normal">Conversion</th>
                <th className="py-2 text-right font-normal">Held</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.sources.map((s) => (
                <tr key={s.source} className="border-b border-line">
                  <td className="py-2.5 pr-4 font-mono text-[13px] text-ink">{s.source}</td>
                  <td className="py-2.5 pr-4 text-right">{s.clicks}</td>
                  <td className="py-2.5 pr-4 text-right">{s.bids}</td>
                  <td className="py-2.5 pr-4 text-right text-muted">{conversion(s) ?? '–'}</td>
                  <td className="py-2.5 text-right text-ink">{formatUsd(s.heldCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="tabular-nums">
              <tr className="font-medium text-ink">
                <td className="py-2.5 pr-4">Total</td>
                <td className="py-2.5 pr-4 text-right">{data.totals.clicks}</td>
                <td className="py-2.5 pr-4 text-right">{data.totals.bids}</td>
                <td className="py-2.5 pr-4 text-right text-muted">
                  {trackedConversion(data.sources) ?? '–'}
                </td>
                <td className="py-2.5 text-right">{formatUsd(data.totals.heldCents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Section>
  );
}
