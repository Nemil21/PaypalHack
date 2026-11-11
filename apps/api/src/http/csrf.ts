import type { FastifyRequest } from 'fastify';
import type { Config } from '@holdfast/core';
import { ApiError } from './errors.js';

/**
 * CSRF (feature 16): SameSite=Lax session cookies plus an Origin check on mutating routes.
 * The SPA is same-origin (M31), so a legitimate browser call's `Origin` is our own host.
 *
 * Rules, for a mutating, non-exempt request:
 *   - `Origin` present → its host must be allowed (`null` never is);
 *   - no `Origin` but a `Referer` → the referer's host must be allowed;
 *   - `Sec-Fetch-Site: cross-site` → refused whatever the other headers say;
 *   - none of these headers → allowed. Browsers always send `Origin` on a cross-origin POST, so
 *     a request without it is a non-browser client (curl, a test), which holds no victim cookies.
 *
 * Allowed hosts: the request's own `Host`, the `APP_BASE_URL` host, and outside production the
 * API's localhost origin (the Vite dev proxy rewrites `Origin` to it; see apps/web/vite.config.ts).
 */
export function allowedHosts(config: Config, req: FastifyRequest): Set<string> {
  const hosts = new Set<string>();
  const host = req.headers.host?.toLowerCase();
  if (host) hosts.add(host);
  if (config.APP_BASE_URL) hosts.add(new URL(config.APP_BASE_URL).host.toLowerCase());
  if (config.NODE_ENV !== 'production') {
    hosts.add(`localhost:${config.PORT}`);
    hosts.add(`127.0.0.1:${config.PORT}`);
  }
  return hosts;
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

const REFUSED = 'Cross-origin request refused.';

export function assertSameOrigin(config: Config, req: FastifyRequest): void {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') throw new ApiError('FORBIDDEN', REFUSED);

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const source = origin ?? referer;
  if (source === undefined) return;

  const host = hostOf(source);
  if (!host || !allowedHosts(config, req).has(host)) throw new ApiError('FORBIDDEN', REFUSED);
}
