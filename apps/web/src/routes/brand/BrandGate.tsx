import { useCallback, useEffect, useState } from 'react';
import { Outlet, useOutletContext } from 'react-router';
import type { BrandListingView } from '@holdfast/shared';
import { PageHeader } from '../../components/layout/AppShell';
import { Button, ErrorBanner, Skeleton } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { clientConfig } from '../../lib/client-config';
import { useApiAction } from '../../lib/use-api-action';

/**
 * Brand session + listings for the console screens (HF-023 Part 1). Loads `GET /api/me` and
 * `GET /api/listings`; on 401 it shows sign-in. With `DEMO_MODE`, "Demo sign-in" offers the seeded
 * OWNER and the read-only VIEWER (HF-006); W02 (HF-010) replaces this prompt with Log in with
 * PayPal.
 */

export type BrandRole = 'OWNER' | 'MANAGER' | 'VIEWER';

export interface BrandMe {
  id: string;
  email: string;
  displayName: string | null;
  role: BrandRole;
  brand: { id: string; name: string; verificationStatus: string };
  /** `ADMIN_EMAILS` member (`GET /api/me`): ops actions such as the payout retry. */
  isAdmin?: boolean;
}

export interface BrandContext {
  me: BrandMe;
  listings: BrandListingView[];
  reloadListings(): void;
}

export function useBrand(): BrandContext {
  return useOutletContext<BrandContext>();
}

type Load =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; error: ApiError }
  | { state: 'ready'; me: BrandMe; listings: BrandListingView[] };

export function BrandGate() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    Promise.all([
      api.request<{ brandUser: BrandMe | null }>({ method: 'GET', path: '/api/me' }),
      // HF-012a's `GET /api/listings`: newest first, this brand only.
      api.request<{ listings: BrandListingView[] }>({ method: 'GET', path: '/api/listings' }),
    ])
      .then(([me, list]) => {
        if (!live) return;
        setLoad(
          me.brandUser
            ? { state: 'ready', me: me.brandUser, listings: list.listings }
            : { state: 'signed-out' },
        );
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setLoad({ state: 'signed-out' });
        } else {
          setLoad({
            state: 'error',
            error: err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed.'),
          });
        }
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
  if (load.state === 'signed-out') return <BrandSignInPrompt onSignedIn={reload} />;
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

function BrandSignInPrompt({ onSignedIn }: { onSignedIn(): void }) {
  const demo = clientConfig().demoMode;
  const signIn = useApiAction<{ brandUser: BrandMe }>();
  const as = async (role: 'OWNER' | 'VIEWER') => {
    signIn.reset();
    const res = await signIn.run({ method: 'POST', path: '/api/auth/demo/brand', body: { role } });
    if (res?.brandUser) onSignedIn();
  };
  return (
    <>
      <PageHeader
        eyebrow="Brand console"
        title="Sign in to see money already waiting."
        lede={
          demo
            ? 'Demo sign-in opens the Aurel Audio console. The viewer account is read-only.'
            : 'Brand sign-in with PayPal is coming next. Ask your Holdfast contact for access.'
        }
      />
      {demo && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => as('OWNER')}
            disabled={signIn.status === 'pending'}
          >
            Demo sign-in · Owner
          </Button>
          <Button
            variant="outline"
            onClick={() => as('VIEWER')}
            disabled={signIn.status === 'pending'}
          >
            Demo sign-in · Viewer
          </Button>
        </div>
      )}
      {signIn.status === 'error' && <ErrorBanner className="mt-4" message={signIn.error.message} />}
    </>
  );
}
