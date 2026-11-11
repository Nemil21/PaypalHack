/**
 * Which requests the HF-006 plumbing applies to. One place, so the CSRF check, the
 * `Idempotency-Key` requirement and the REST rate limit agree on the exemptions.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Log in with PayPal returns here (HF-010); PayPal, not our SPA, is the caller. */
export const OAUTH_CALLBACK_PATH = '/api/auth/paypal/callback';

export function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isMutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

export function isWebhookPath(path: string): boolean {
  return under(path, '/api/webhooks') || under(path, '/webhooks');
}

export function isMcpPath(path: string): boolean {
  return under(path, '/mcp');
}

/**
 * Exempt from the CSRF Origin check and the `Idempotency-Key` requirement (api.md, feature 16):
 * webhooks (provider signatures), `/mcp` (bearer token, cookies ignored; keys per tool call)
 * and the OAuth callback.
 */
export function isCsrfAndKeyExempt(path: string): boolean {
  return isWebhookPath(path) || isMcpPath(path) || path === OAUTH_CALLBACK_PATH;
}

/** Infrastructure endpoints outside the per-user REST limit. */
const UNLIMITED = ['/api/healthz', '/healthz', '/api/client-config'];

/** Counted against the REST limit (60/min/user): every `/api` route except the above. */
export function isRestLimited(path: string): boolean {
  return under(path, '/api') && !isWebhookPath(path) && !UNLIMITED.includes(path);
}
