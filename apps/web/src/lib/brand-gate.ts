import type { BrandListingView } from '@holdfast/shared';
import { ApiError, type ApiRequest } from './api';

/** Brand session load for `BrandGate` (HF-023, HF-010), kept pure so it can be tested. */

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

export type BrandGateLoad =
  | { state: 'loading' }
  | { state: 'signed-out' }
  /** Signed in with PayPal, no `brand_users` row yet (HF-010): W03 next. */
  | { state: 'pending' }
  | { state: 'error'; error: ApiError }
  | { state: 'ready'; me: BrandMe; listings: BrandListingView[] };

interface Requester {
  request<T>(req: ApiRequest): Promise<T>;
}

/**
 * `GET /api/me` first; `GET /api/listings` (brand-guarded) only once there is a brand user, so a
 * pending PayPal identity is never turned into "signed out" by the listings 401.
 */
export async function loadBrandGate(client: Requester): Promise<BrandGateLoad> {
  try {
    const me = await client.request<{
      brandUser: BrandMe | null;
      pendingBrand?: { email: string } | null;
    }>({ method: 'GET', path: '/api/me' });
    if (!me.brandUser) return me.pendingBrand ? { state: 'pending' } : { state: 'signed-out' };
    // HF-012a's `GET /api/listings`: newest first, this brand only.
    const list = await client.request<{ listings: BrandListingView[] }>({
      method: 'GET',
      path: '/api/listings',
    });
    return { state: 'ready', me: me.brandUser, listings: list.listings };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return { state: 'signed-out' };
    }
    return {
      state: 'error',
      error: err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed.'),
    };
  }
}
