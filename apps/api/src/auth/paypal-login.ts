import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Config } from '@holdfast/core';

/**
 * Log in with PayPal (HF-010): the OpenID Connect identity flow for brand managers.
 *
 *   1. authorize  https://www.sandbox.paypal.com/signin/authorize?client_id&response_type=code
 *                 &scope=openid email https://uri.paypal.com/services/paypalattributes
 *                 &redirect_uri&state
 *   2. token      POST {PAYPAL_API_BASE}/v1/oauth2/token  grant_type=authorization_code&code=…
 *                 (Basic client credentials; server side only, the secret never reaches a browser)
 *   3. userinfo   GET  {PAYPAL_API_BASE}/v1/identity/oauth2/userinfo?schema=paypalv1.1  (Bearer)
 *
 * LIPP is not covered by the S7 spike (M20); the userinfo reader below accepts both the OIDC
 * fields (`email`, `email_verified`) and the paypalv1.1 ones (`emails[]`, `payer_id`).
 * `PAYPAL_MODE=stub` uses `StubPayPalIdentity`: the authorize URL points straight back at the
 * callback and the code resolves to a fixed, not-yet-onboarded brand identity.
 */

export const LIPP_SCOPES = ['openid', 'email', 'https://uri.paypal.com/services/paypalattributes'];

export interface PayPalLoginIdentity {
  /** Lower-cased login email. */
  email: string;
  emailVerified: boolean;
  /** PayPal payer id (needs the `paypalattributes` scope); HF-011b writes `brands.paypal_payer_id`. */
  payerId: string | null;
  name: string | null;
}

export interface PayPalIdentity {
  /** The PayPal consent URL the browser is sent to. Carries only public values. */
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  /** Exchange an authorization code for the signed-in PayPal identity. */
  exchange(code: string): Promise<PayPalLoginIdentity>;
}

/** Why an exchange failed; never carries the code, tokens or credentials. */
export class PayPalLoginError extends Error {
  constructor(
    readonly stage: 'token' | 'userinfo',
    readonly http: number,
    readonly code: string,
  ) {
    super(`Log in with PayPal ${stage} failed: ${code} (HTTP ${http})`);
    this.name = 'PayPalLoginError';
  }
}

/** The consent host that pairs with an API base (sandbox API → sandbox consent). */
export function authorizeBaseFor(apiBase: string): string {
  const host = new URL(apiBase).hostname;
  return host.includes('sandbox') ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';
}

/** Reads a userinfo body defensively (OIDC and paypalv1.1 schemas). */
export function identityFromUserinfo(json: Record<string, unknown>): PayPalLoginIdentity | null {
  const emails = Array.isArray(json.emails)
    ? (json.emails as Array<Record<string, unknown>>).filter(
        (e) => e && typeof e.value === 'string',
      )
    : [];
  const primary = emails.find((e) => e.primary === true || e.primary === 'true') ?? emails[0];
  const email =
    typeof json.email === 'string' ? json.email : primary ? (primary.value as string) : null;
  if (!email) return null;
  const truthy = (v: unknown) => v === true || v === 'true';
  // OIDC's `email_verified`, else the paypalv1.1 `confirmed` flag on that same address.
  const chosen = emails.find((e) => String(e.value).toLowerCase() === email.toLowerCase());
  const emailVerified =
    'email_verified' in json ? truthy(json.email_verified) : truthy(chosen?.confirmed);
  const payerId = typeof json.payer_id === 'string' && json.payer_id ? json.payer_id : null;
  const name = typeof json.name === 'string' && json.name ? json.name : null;
  return { email: email.trim().toLowerCase(), emailVerified, payerId, name };
}

export interface RestPayPalIdentityOptions {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class RestPayPalIdentity implements PayPalIdentity {
  readonly #opts: RestPayPalIdentityOptions;
  readonly #fetch: typeof fetch;

  constructor(opts: RestPayPalIdentityOptions) {
    this.#opts = { ...opts, apiBase: opts.apiBase.replace(/\/+$/, '') };
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({
      flowEntry: 'static',
      client_id: this.#opts.clientId,
      response_type: 'code',
      scope: LIPP_SCOPES.join(' '),
      redirect_uri: redirectUri,
      state,
    });
    return `${authorizeBaseFor(this.#opts.apiBase)}/signin/authorize?${q.toString()}`;
  }

  async exchange(code: string): Promise<PayPalLoginIdentity> {
    const basic = Buffer.from(`${this.#opts.clientId}:${this.#opts.clientSecret}`).toString(
      'base64',
    );
    const token = await this.#call('token', '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
    });
    const accessToken = token.access_token;
    if (typeof accessToken !== 'string') throw new PayPalLoginError('token', 200, 'NO_TOKEN');

    const info = await this.#call('userinfo', '/v1/identity/oauth2/userinfo?schema=paypalv1.1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const identity = identityFromUserinfo(info);
    if (!identity) throw new PayPalLoginError('userinfo', 200, 'NO_EMAIL');
    return identity;
  }

  async #call(
    stage: 'token' | 'userinfo',
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.#fetch(this.#opts.apiBase + path, {
        ...init,
        headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError';
      throw new PayPalLoginError(stage, 0, timeout ? 'TIMEOUT' : 'NETWORK');
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON answer: handled by the status check below.
    }
    if (!res.ok) {
      // `invalid_grant` = used or expired code. Only PayPal's error code is kept.
      const code = typeof json.error === 'string' ? json.error : `HTTP_${res.status}`;
      throw new PayPalLoginError(stage, res.status, code);
    }
    return json;
  }
}

/** The identity every stub sign-in resolves to: a brand that has not onboarded yet. */
export const STUB_LIPP_IDENTITY: PayPalLoginIdentity = {
  email: 'new-brand@holdfast.demo',
  emailVerified: true,
  payerId: 'STUBPAYER0000001',
  name: 'New Brand (stub)',
};

/**
 * `PAYPAL_MODE=stub` and tests. `identities` maps codes to identities (default: `stub-code` →
 * `STUB_LIPP_IDENTITY`); an unknown code fails like PayPal's `invalid_grant`. `exchanged` records
 * every code exchanged, so tests can prove a rejected callback never reached PayPal.
 */
export class StubPayPalIdentity implements PayPalIdentity {
  readonly exchanged: string[] = [];
  constructor(
    readonly identities: Map<string, PayPalLoginIdentity> = new Map([
      ['stub-code', STUB_LIPP_IDENTITY],
    ]),
  ) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const q = new URLSearchParams({ code: 'stub-code', state });
    return `${redirectUri}?${q.toString()}`;
  }

  async exchange(code: string): Promise<PayPalLoginIdentity> {
    this.exchanged.push(code);
    const identity = this.identities.get(code);
    if (!identity) throw new PayPalLoginError('token', 400, 'invalid_grant');
    return { ...identity };
  }
}

export function createPayPalIdentity(config: Config): PayPalIdentity {
  if (config.PAYPAL_MODE === 'stub') return new StubPayPalIdentity();
  return new RestPayPalIdentity({
    apiBase: config.PAYPAL_API_BASE,
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
  });
}

// --- Pending brand identity (signed-in with PayPal, no brand_users row yet) -------------------

/**
 * Unknown emails keep their PayPal identity in this cookie only (no `brand_users` row before
 * HF-011b's verification step). Sealed with AES-256-GCM under a key derived from SESSION_SECRET,
 * so the email and payer id are neither readable nor forgeable client side.
 */
export interface PendingBrandIdentity {
  email: string;
  payerId: string | null;
  name: string | null;
  /** Expiry, epoch ms. */
  exp: number;
}

function sealKey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`holdfast:${purpose}`).digest();
}

function seal(secret: string, purpose: string, value: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The sealed JSON object, or null when malformed, forged or sealed for another purpose. */
function unseal(
  secret: string,
  purpose: string,
  sealed: string | undefined,
): Record<string, unknown> | null {
  if (!sealed || sealed.length > 4096) return null;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', sealKey(secret, purpose), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function sealPending(secret: string, identity: PendingBrandIdentity): string {
  return seal(secret, 'brand-pending', identity);
}

export function openPending(
  secret: string,
  sealed: string | undefined,
  now: number = Date.now(),
): PendingBrandIdentity | null {
  const v = unseal(secret, 'brand-pending', sealed);
  if (!v || typeof v.email !== 'string' || typeof v.exp !== 'number' || v.exp <= now) return null;
  return {
    email: v.email,
    payerId: typeof v.payerId === 'string' ? v.payerId : null,
    name: typeof v.name === 'string' ? v.name : null,
    exp: v.exp,
  };
}

// --- Payout account re-login (HF-056) ---------------------------------------------------------

/**
 * W11 "Change payout account": an OWNER signs in with PayPal again, as the account payouts should
 * go to. The fresh identity is kept for 10 minutes in a sealed cookie bound to that OWNER's
 * `brand_users.id`; `POST /api/brands/me/payout-account` consumes it.
 */
export interface PayoutReauthIdentity {
  brandUserId: string;
  email: string;
  payerId: string | null;
  /** Expiry, epoch ms. */
  exp: number;
}

export function sealPayoutReauth(secret: string, identity: PayoutReauthIdentity): string {
  return seal(secret, 'payout-reauth', identity);
}

export function openPayoutReauth(
  secret: string,
  sealed: string | undefined,
  now: number = Date.now(),
): PayoutReauthIdentity | null {
  const v = unseal(secret, 'payout-reauth', sealed);
  if (
    !v ||
    typeof v.brandUserId !== 'string' ||
    typeof v.email !== 'string' ||
    typeof v.exp !== 'number' ||
    v.exp <= now
  ) {
    return null;
  }
  return {
    brandUserId: v.brandUserId,
    email: v.email,
    payerId: typeof v.payerId === 'string' ? v.payerId : null,
    exp: v.exp,
  };
}

/** Constant-time string compare for the OAuth `state`. */
export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
