import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, stateless tokens (HMAC-SHA256 over `SESSION_SECRET`) for session cookies and magic
 * links. `payload.signature`, both base64url. Each token carries a `purpose`, and the key is
 * derived per purpose, so a magic-link token can never pass as a session and vice versa.
 * Tokens never carry an email in the cookie; the magic-link token carries one but only travels
 * in the (redacted) link.
 */

export type TokenPurpose = 'brand-session' | 'shopper-session' | 'magic-link';

export interface TokenClaims {
  /** Subject: a brand_users.id / shoppers.id, or an email for magic links. */
  sub: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Random id: unique per token (magic links are single-use by `jti`). */
  jti: string;
  /** Free-form extra claims (e.g. the provisional shopper a magic link was requested from). */
  ext?: Record<string, string>;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function keyFor(secret: string, purpose: TokenPurpose): Buffer {
  return createHmac('sha256', secret).update(`holdfast:${purpose}`).digest();
}

function mac(secret: string, purpose: TokenPurpose, body: string): Buffer {
  return createHmac('sha256', keyFor(secret, purpose)).update(body).digest();
}

export function signToken(
  secret: string,
  purpose: TokenPurpose,
  claims: Omit<TokenClaims, 'jti'> & { jti?: string },
): string {
  const full: TokenClaims = { ...claims, jti: claims.jti ?? randomBytes(12).toString('base64url') };
  const body = b64url(JSON.stringify(full));
  return `${body}.${b64url(mac(secret, purpose, body))}`;
}

/** The claims, or null when the token is malformed, forged, for another purpose or expired. */
export function verifyToken(
  secret: string,
  purpose: TokenPurpose,
  token: string | undefined,
  now: number = Date.now(),
): TokenClaims | null {
  if (!token || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = mac(secret, purpose, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const c = claims as Partial<TokenClaims>;
  if (typeof c.sub !== 'string' || typeof c.exp !== 'number' || typeof c.jti !== 'string') {
    return null;
  }
  if (c.exp <= now) return null;
  return c as TokenClaims;
}

// --- Cookies ---------------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec: number;
  secure: boolean;
}

/** HttpOnly, SameSite=Lax, Path=/ always (feature 16); `Secure` on HTTPS and in production. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`,
  ];
  if (opts.maxAgeSec <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
