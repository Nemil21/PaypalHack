/**
 * HF-047 security checklist (features/16): a log sample holds no secrets or card data, and no
 * route puts personal data in its URL. Runs the production logger options (`loggerOptions`) over
 * the kinds of lines the app writes: request lines, PayPal error bodies, config dumps.
 * No database needed.
 */
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Db } from '@holdfast/core';
import { sealToken } from '../auth/tokens.js';
import { loggerOptions, redactString } from '../http/redact.js';
import { buildServer } from '../server.js';

// Sample secrets, shaped like the real ones (none of these is real).
const PAYPAL_CLIENT_ID = 'AYsample-client-id-0123456789abcdefABCDEF';
const PAYPAL_CLIENT_SECRET = 'EKsample-client-secret-0123456789abcdefXYZ';
const SESSION_SECRET = 'session-secret-'.padEnd(48, 'z');
const CHANNEL3_WEBHOOK_SECRET = 'whsec_sample0123456789';
const ANTHROPIC_API_KEY = 'sk-ant-sample-0123456789';
const PAYPAL_ACCESS_TOKEN = 'A21AAsampleAccessToken0123456789';
const EC_TOKEN = 'EC-5Y6538123T928473B'; // gitleaks:allow (fake sample)
const MCP_TOKEN = 'hf_mcp_SampleToken0123456789abcdef';
const CARD = '4111111111111111';
const CARD_SPACED = '4012 8888 8888 1881';
const CVV = '9174';
const EMAIL = 'maya.shopper@example.com';
const PAYER_EMAIL = 'payouts@aurel.example';

const SECRETS = [
  PAYPAL_CLIENT_SECRET,
  SESSION_SECRET,
  CHANNEL3_WEBHOOK_SECRET,
  ANTHROPIC_API_KEY,
  PAYPAL_ACCESS_TOKEN,
  EC_TOKEN,
  MCP_TOKEN,
  CARD,
  CARD_SPACED,
  CARD_SPACED.replace(/ /g, ''),
  EMAIL,
  PAYER_EMAIL,
  Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'),
];

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

describe('HF-047 log sample', () => {
  it('contains no secrets, tokens, card data or emails', async () => {
    const { lines, stream } = capture();
    const app = Fastify({ logger: { ...loggerOptions('debug'), stream } as never });
    const magic = sealToken(SESSION_SECRET, 'magic-link', {
      sub: EMAIL,
      exp: Date.now() + 60_000,
    });

    app.get('/api/bids/return', async (req) => {
      // A PayPal 422 as the client logs it: request id, debug id and the echoed payment source.
      req.log.warn(
        {
          paypal: {
            op: 'order_create',
            status: 422,
            debugId: 'f00dfeed1234',
            body: {
              name: 'UNPROCESSABLE_ENTITY',
              payment_source: {
                card: { number: CARD, security_code: CVV, expiry: '2030-12', name: 'Maya S' },
              },
              payer: { email_address: EMAIL },
            },
          },
        },
        `capture failed for ${EMAIL}; card ${CARD_SPACED}, cvv ${CVV}`,
      );
      // A token exchange gone wrong, logged with the outgoing headers.
      req.log.error(
        {
          err: new Error(`oauth failed: Authorization: Basic ${SECRETS.at(-1)}`),
          headers: { Authorization: `Bearer ${PAYPAL_ACCESS_TOKEN}` },
          response: { access_token: PAYPAL_ACCESS_TOKEN, app_id: 'APP-80W284485P519543T' },
        },
        'paypal oauth',
      );
      // A config dump (a startup misconfiguration report).
      req.log.info(
        {
          config: {
            PAYPAL_CLIENT_ID,
            PAYPAL_CLIENT_SECRET,
            SESSION_SECRET,
            CHANNEL3_WEBHOOK_SECRET,
            ANTHROPIC_API_KEY,
            paypalWebhookSecret: CHANNEL3_WEBHOOK_SECRET,
          },
        },
        'config',
      );
      req.log.info({ payout: { receiver: PAYER_EMAIL, amountCents: 22_900 } }, 'payout sent');
      // Non-secret numbers must survive: an epoch-ms timestamp and an amount.
      req.log.info(`retry at 1794427548174 for 22900 cents`);
      return {};
    });

    await app.inject({
      method: 'GET',
      url: `/api/bids/return?token=${EC_TOKEN}&PayerID=PAYER123`,
      headers: {
        authorization: `Bearer ${MCP_TOKEN}`,
        cookie: `hf_shopper=${magic}`,
        'paypal-auth-assertion': 'eyJhbGciOiJub25lIn0.eyJpc3MiOiJ4In0.', // gitleaks:allow (fake sample)
      },
    });
    await app.inject({
      method: 'GET',
      url: `/api/auth/shopper/magic-link/verify?token=${magic}`,
    });
    await app.close();

    const sample = lines.join('\n');
    expect(sample.length).toBeGreaterThan(500);
    for (const s of SECRETS) expect(sample).not.toContain(s);
    expect(sample).not.toContain(magic);
    // Anchored to its context: a bare 4-digit string turns up in `time` / `responseTime` digits.
    expect(sample).not.toMatch(new RegExp(`(cvv|security_code)\\W{0,4}${CVV}`, 'i'));
    expect(sample).toContain('cvv [redacted]');
    expect(sample).toContain('[card]');
    expect(sample).toContain('1794427548174');
    expect(sample).toContain('22900');
  });

  it('redacts Luhn-valid card numbers only', () => {
    expect(redactString(`card ${CARD} and 5555-5555-5555-4444, amex 378282246310005`)).toBe(
      'card [card] and [card], amex [card]',
    );
    // Not Luhn-valid, or not a card network's first digit: ids, timestamps, amounts survive.
    expect(redactString('order 4111111111111112 at 1794427548174 for 100000 cents')).toBe(
      'order 4111111111111112 at 1794427548174 for 100000 cents',
    );
  });
});

describe('HF-047 no personal data in URLs', () => {
  it('no route takes an email, name, phone or address in its path', async () => {
    // Route registration never queries: a stub `Db` mounts every database-backed route.
    const db = { pool: {}, tx: async () => undefined } as unknown as Db;
    const money = { db, paypal: {} as never };
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5432/d',
      SESSION_SECRET,
      PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET,
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
      NODE_ENV: 'test',
    });
    const app = buildServer(config, {
      webDistDir: null,
      sql: db,
      bids: { money } as never,
      clear: { money } as never,
      listings: { money } as never,
    });
    await app.ready();
    const table = app.printRoutes({ commonPrefix: false });
    await app.close();
    // Sanity: the database-backed routes were mounted.
    expect(table).toContain('magic-link');
    expect(table).toContain(':bidId');
    expect(table).not.toMatch(/:(email|e-?mail|name|phone|address|payer)\b/i);
  });
});
