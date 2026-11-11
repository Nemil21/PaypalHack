import { describe, expect, it } from 'vitest';
import { ApiError, type ApiRequest } from './api';
import { loadBrandGate, type BrandMe } from './brand-gate';

const OWNER: BrandMe = {
  id: 'u1',
  email: 'owner@brand.example',
  displayName: null,
  role: 'OWNER',
  brand: { id: 'b1', name: 'Aurel Audio', verificationStatus: 'VERIFIED' },
};

/** A fake API: `/api/me` answers `me`; `/api/listings` is brand-guarded like the real route. */
function fakeApi(me: unknown) {
  const calls: string[] = [];
  const client = {
    async request<T>(req: ApiRequest): Promise<T> {
      calls.push(req.path);
      if (req.path === '/api/me') return me as T;
      const signedIn = (me as { brandUser: unknown }).brandUser;
      if (!signedIn) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to your brand account.');
      return { listings: [] } as T;
    },
  };
  return { client, calls };
}

describe('BrandGate load (HF-010)', () => {
  it('only a pending PayPal identity → pending (W03), listings never requested', async () => {
    const { client, calls } = fakeApi({
      brandUser: null,
      pendingBrand: { email: 'newbie@brand.example' },
    });
    await expect(loadBrandGate(client)).resolves.toEqual({ state: 'pending' });
    expect(calls).toEqual(['/api/me']);
  });

  it('no session → signed-out (W02)', async () => {
    const { client } = fakeApi({ brandUser: null, pendingBrand: null });
    await expect(loadBrandGate(client)).resolves.toEqual({ state: 'signed-out' });
  });

  it('brand session → ready with listings', async () => {
    const { client, calls } = fakeApi({ brandUser: OWNER, pendingBrand: null });
    await expect(loadBrandGate(client)).resolves.toEqual({
      state: 'ready',
      me: OWNER,
      listings: [],
    });
    expect(calls).toEqual(['/api/me', '/api/listings']);
  });

  it('a non-auth failure is an error, not signed-out', async () => {
    const client = {
      async request<T>(): Promise<T> {
        throw new ApiError(500, 'INTERNAL', 'Boom.');
      },
    };
    const load = await loadBrandGate(client);
    expect(load.state).toBe('error');
  });
});
