import { useCallback, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useOutletContext } from 'react-router';
import type { BrandListingView } from '@holdfast/shared';
import { ErrorBanner, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { loadBrandGate, type BrandGateLoad, type BrandMe } from '../../lib/brand-gate';
import { paths } from '../../lib/routes';

/**
 * Brand session + listings for the console screens (HF-023 Part 1). Loads `GET /api/me` and
 * `GET /api/listings`. Signed out → W02 (`/brand/sign-in?next=…`, HF-010: Log in with PayPal and
 * the DEMO_MODE sign-ins); signed in with PayPal but not onboarded yet → W03.
 */

export type { BrandMe, BrandRole } from '../../lib/brand-gate';

export interface BrandContext {
  me: BrandMe;
  listings: BrandListingView[];
  reloadListings(): void;
}

export function useBrand(): BrandContext {
  return useOutletContext<BrandContext>();
}

type Load = BrandGateLoad;

export function BrandGate() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const location = useLocation();

  useEffect(() => {
    let live = true;
    void loadBrandGate(api).then((next) => {
      if (live) setLoad(next);
    });
    return () => {
      live = false;
    };
  }, [nonce]);

  if (load.state === 'loading') {
    return (
      <div className="flex flex-col gap-4 pt-8" aria-busy>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-[150px] w-full" />
      </div>
    );
  }
  if (load.state === 'pending') return <Navigate to={paths.brandOnboarding} replace />;
  if (load.state === 'signed-out') {
    const next = location.pathname + location.search;
    return <Navigate to={`${paths.brandSignIn}?next=${encodeURIComponent(next)}`} replace />;
  }
  if (load.state === 'error') {
    return (
      <div className="pt-8">
        <ErrorBanner message={load.error.message} onRetry={reload} />
      </div>
    );
  }
  const ctx: BrandContext = { me: load.me, listings: load.listings, reloadListings: reload };
  return <Outlet context={ctx} />;
}
