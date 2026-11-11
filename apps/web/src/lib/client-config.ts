/**
 * Runtime config from `GET /api/client-config` (apps/api/src/web.ts). Loaded once before the first
 * render. If the API is unreachable the app still boots: AG components then render with the trial
 * watermark and the demo hub hides demo-only links.
 */
export interface ClientConfig {
  agGridLicenseKey: string | null;
  demoMode: boolean;
  /** Public PayPal client id for the JS SDK v6 card fields; null with the FakePayPal stub. */
  paypalClientId: string | null;
  paypalSandbox: boolean;
  /** The labelled "Use sandbox test card" button (DEMO_MODE on sandbox / stub). */
  testCardEnabled: boolean;
}

const FALLBACK: ClientConfig = {
  agGridLicenseKey: null,
  demoMode: false,
  paypalClientId: null,
  paypalSandbox: true,
  testCardEnabled: false,
};

let current: ClientConfig = FALLBACK;

export async function loadClientConfig(): Promise<ClientConfig> {
  try {
    const res = await fetch('/api/client-config', { credentials: 'same-origin' });
    if (res.ok) current = { ...FALLBACK, ...((await res.json()) as Partial<ClientConfig>) };
  } catch {
    // Keep the fallback; the dev components page shows the licence as missing.
  }
  return current;
}

export function clientConfig(): ClientConfig {
  return current;
}
