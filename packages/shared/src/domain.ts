import { z } from 'zod';

/**
 * Brand website domain normaliser (HF-011a, shared with the W03 form and
 * `POST /brands/verification` in HF-011b). `brands.domain` is UNIQUE, so every writer and every
 * lookup goes through this one function:
 *
 *   " HTTPS://www.AurelAudio.example/shop?x=1 " → "aurelaudio.example"
 *
 * Lower-case; strip the scheme, any `user@`, the port, the path / query / fragment, a leading
 * `www.` and a trailing dot. Returns null when what is left is not a plausible hostname (at least
 * two labels, each 1–63 of `a-z 0-9 -`, not starting or ending with `-`; 253 characters at most).
 * Internationalised names must be entered in punycode (`xn--…`).
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^\/\//, ''); // protocol-relative
  s = s.split(/[/?#]/, 1)[0]!; // path, query, fragment
  s = s.slice(s.lastIndexOf('@') + 1); // userinfo
  s = s.replace(/:\d*$/, ''); // port
  s = s.replace(/\.$/, ''); // trailing dot (FQDN form)
  s = s.replace(/^www\./, '');
  return isHostname(s) ? s : null;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isHostname(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  const labels = s.split('.');
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels.at(-1)!);
}

/** Zod field for a domain input: normalises, or fails with a readable message. */
export const domainSchema = z.string().transform((v, ctx) => {
  const d = normalizeDomain(v);
  if (d === null) {
    ctx.addIssue({ code: 'custom', message: 'must be a website domain like aurelaudio.example' });
    return z.NEVER;
  }
  return d;
});
