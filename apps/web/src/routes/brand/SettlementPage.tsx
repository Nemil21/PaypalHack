import { useCallback } from 'react';
import { useParams } from 'react-router';
import type { BrandBidView } from '@holdfast/shared';
import { ErrorBanner } from '../../components/ui';
import { api } from '../../lib/api';
import { paths } from '../../lib/routes';
import { useSettlementView } from '../../lib/settlement/use-settlement-view';
import { useApiAction } from '../../lib/use-api-action';
import { useBrand } from './BrandGate';
import { SettlementScreen } from './SettlementScreen';

/**
 * W08 live route (HF-035): `/brand/listings/:listingId/settlement`. Reads the SettlementView and
 * re-reads it on SSE notices; the drawer reads the brand-scoped bid view; admins
 * (`ADMIN_EMAILS`) get the payout retry on a failed payout.
 */
export function SettlementPage() {
  const { listingId = '' } = useParams();
  const { me, listings } = useBrand();
  const live = useSettlementView(listingId);
  const retry = useApiAction<unknown>();

  const title =
    listings.find((l) => l.listingId === listingId)?.product.title ??
    (live.view ? 'Listing' : null);

  const loadBid = useCallback(
    (bidId: string) =>
      api.request<BrandBidView>({
        method: 'GET',
        path: `/api/listings/${encodeURIComponent(listingId)}/bids/${encodeURIComponent(bidId)}`,
      }),
    [listingId],
  );

  if (live.error) {
    return (
      <div className="pt-8">
        <ErrorBanner
          message={
            live.error.status === 404 ? 'We could not find this settlement.' : live.error.message
          }
          onRetry={live.error.status === 404 ? undefined : live.refresh}
        />
      </div>
    );
  }

  return (
    <SettlementScreen
      view={live.view}
      title={title}
      backHref={paths.listingConsole(listingId)}
      stream={live.stream}
      stale={live.stale}
      onRefresh={live.refresh}
      loadBid={loadBid}
      retryPayout={
        me.isAdmin
          ? {
              pending: retry.status === 'pending',
              error: retry.status === 'error' ? retry.error.message : null,
              run: async () => {
                const ok = await retry.run({
                  method: 'POST',
                  path: `/api/admin/listings/${encodeURIComponent(listingId)}/retry-payout`,
                });
                if (ok !== undefined) {
                  retry.reset();
                  live.refresh();
                }
              },
            }
          : undefined
      }
    />
  );
}
