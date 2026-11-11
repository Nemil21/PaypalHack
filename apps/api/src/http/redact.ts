import type { FastifyServerOptions } from 'fastify';

/**
 * Log redaction (feature 16: "Logs redact emails and PayPal tokens"; HF-047 adds card data and
 * secret-named keys). Pino's `redact` paths cover known headers; this covers values anywhere in
 * a log line: message strings, merged objects and the request URL (the wallet return and magic
 * links carry `?token=`).
 */

const REDACTED = '[redacted]';

const PATTERNS: [RegExp, string][] = [
  // Credentials in query strings or form bodies: ?token=…, &code=…, access_token=…
  [
    /\b(token|code|access_token|refresh_token|id_token|client_secret)=[^&\s#"']+/gi,
    `$1=${REDACTED}`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
  // PayPal OAuth access tokens and EC- approval tokens.
  [/\bA21AA[A-Za-z0-9_.-]{8,}/g, REDACTED],
  [/\bEC-[A-Z0-9]{8,}\b/g, REDACTED],
  // Holdfast MCP tokens (HF-043), wherever they appear.
  [/\bhf_mcp_[A-Za-z0-9_-]+/g, REDACTED],
  // Card security codes written out in a message: "cvv 123", "security_code=1234".
  [/\b(cvv2?|cvc|security[_ ]?code)(["']?\s*[:=]?\s*["']?)\d{3,4}\b/gi, `$1$2${REDACTED}`],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

/**
 * Card numbers: 13–19 digits, optionally grouped by single spaces or dashes, redacted only if
 * Luhn-valid. The first digit is a card network's (2–6), so epoch-ms timestamps (1…) survive.
 */
const CARD_CANDIDATE = /\b[2-6](?:[ -]?\d){12,18}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Object keys whose values are always secret or personal, whatever they look like. */
const SECRET_KEY =
  /^(email|payer_?email|receiver|password|secret|client_?secret|token|access_?token|refresh_?token|id_?token|authorization|cookie|set-cookie|session|card|card_?number|pan|cvv2?|cvc|security_?code|expiry|exp(iry|iration)?_?date)$/i;
/** Keys that name a secret anywhere in them: `PAYPAL_CLIENT_SECRET`, `webhookSecret`, `apiKey` … */
const SECRET_KEY_PART = /secret|password|passwd|api_?key|license_?key|private_?key/i;

export function redactString(s: string): string {
  let out = s;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out.replace(CARD_CANDIDATE, (m) => (luhnValid(m.replace(/\D/g, '')) ? '[card]' : m));
}

/** Deep copy with secrets replaced. Errors keep their message and stack (both redacted). */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (value instanceof Error) {
    const copy: Record<string, unknown> = {
      type: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
    for (const [k, v] of Object.entries(value)) copy[k] = redactEntry(k, v, depth);
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  // Class instances (Fastify's request, streams …) go to pino's serializers untouched.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactEntry(k, v, depth);
  return out;
}

function redactEntry(key: string, value: unknown, depth: number): unknown {
  if (
    (SECRET_KEY.test(key) || SECRET_KEY_PART.test(key)) &&
    value !== null &&
    value !== undefined
  ) {
    return REDACTED;
  }
  return redactValue(value, depth + 1);
}

/** Fastify logger options with header redaction, value redaction and a redacted `req.url`. */
export function loggerOptions(level: string): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["paypal-auth-assertion"]',
        'res.headers["set-cookie"]',
      ],
      censor: REDACTED,
    },
    serializers: {
      req(req: { method?: string; url?: string; hostname?: string }) {
        return { method: req.method, url: redactString(req.url ?? ''), hostname: req.hostname };
      },
    },
    hooks: {
      logMethod(args, method) {
        const redacted = (args as unknown[]).map((a) => redactValue(a));
        return method.apply(this, redacted as Parameters<typeof method>);
      },
    },
  };
}
