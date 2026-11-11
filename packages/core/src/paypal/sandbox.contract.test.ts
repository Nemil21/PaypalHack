import { describe, it } from 'vitest';
import { isSandboxPayPalBase } from '../config.js';
import { loadDotenv } from '../env.js';
import { PayPalRestClient } from './client.js';
import { faultyFetch, paypalContract } from './test-harness.js';

/**
 * The contract suite against the real PayPal sandbox. Manual / nightly only:
 *   PAYPAL_CONTRACT=sandbox npx vitest run packages/core/src/paypal/sandbox.contract.test.ts
 * Add PAYPAL_CONTRACT_PAYOUT=1 to also send a $1 payout to PAYPAL_BRAND_EMAIL.
 * Reads credentials from `.env`; never prints them. Refuses a non-sandbox base.
 */
const enabled = process.env.PAYPAL_CONTRACT === 'sandbox';

if (enabled) {
  loadDotenv();
  const base = process.env.PAYPAL_API_BASE ?? '';
  if (!isSandboxPayPalBase(base))
    throw new Error('the sandbox contract suite runs only against a PayPal sandbox base');
  paypalContract('PayPal sandbox', () => {
    const faults = faultyFetch(globalThis.fetch.bind(globalThis));
    return {
      client: new PayPalRestClient({
        baseUrl: base,
        clientId: process.env.PAYPAL_CLIENT_ID ?? '',
        clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
        fetch: faults.fetch,
        allowRawCard: true,
        allowMockResponse: true,
        timeoutMs: 30_000,
      }),
      fail503: faults.fail503,
      mockResponses: true,
      payoutEmail:
        process.env.PAYPAL_CONTRACT_PAYOUT === '1' ? process.env.PAYPAL_BRAND_EMAIL : undefined,
      timeoutMs: 90_000,
    };
  });
} else {
  describe('PayPal contract: sandbox', () => {
    it.skip('set PAYPAL_CONTRACT=sandbox to run against the PayPal sandbox', () => {});
  });
}
