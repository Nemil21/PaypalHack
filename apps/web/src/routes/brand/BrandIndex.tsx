import { Navigate } from 'react-router';
import { PageHeader } from '../../components/layout/AppShell';
import { ButtonLink, EmptyState } from '../../components/ui';
import { paths } from '../../lib/routes';
import { useBrand } from './BrandGate';

/**
 * `/brand` (HF-023 Part 1 fallback): straight to the newest listing's console. HF-026 replaces
 * this with the W04 overview.
 */
export function BrandIndex() {
  const { listings, me } = useBrand();
  const newest = listings[0];
  if (newest) return <Navigate to={paths.listingConsole(newest.listingId)} replace />;
  return (
    <>
      <PageHeader eyebrow={me.brand.name} title="No windows yet." />
      <EmptyState
        message="Create a listing to start collecting held bids."
        action={
          me.role === 'VIEWER' ? undefined : (
            <ButtonLink to={paths.newListing}>New listing</ButtonLink>
          )
        }
      />
    </>
  );
}
