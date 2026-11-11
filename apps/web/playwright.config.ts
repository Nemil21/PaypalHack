import { defineConfig, devices } from '@playwright/test';

/**
 * E2E (HF-019 test plan): offer page → test-card hold → confirmation route, on the FakePayPal stub.
 * Opt-in and local: needs a local Postgres in E2E_DATABASE_URL (wiped and migrated by
 * e2e/global-setup.ts on every run) and a built web app.
 *
 *   npm run build -w @holdfast/web
 *   E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/holdfast_e2e npm run e2e -w @holdfast/web
 *
 * The server runs from source (tsx) with PAYPAL_MODE=stub and DEMO_MODE=true, so no PayPal call
 * leaves the machine. Card fields need the real sandbox: set E2E_PAYPAL=sandbox (manual script).
 */
const PORT = Number(process.env.E2E_PORT ?? 3919);
const SANDBOX = process.env.E2E_PAYPAL === 'sandbox';

/** Stub runs never read real credentials: these win over `.env` (loadDotenv doesn't override). */
const STUB_ENV = {
  SESSION_SECRET: 'e2e-only-session-secret-not-for-production-use',
  PAYPAL_CLIENT_ID: 'e2e-stub-client-id',
  PAYPAL_CLIENT_SECRET: 'e2e-stub-client-secret',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
};

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --import tsx ../api/src/main.ts',
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? '',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      APP_BASE_URL: `http://127.0.0.1:${PORT}`,
      ...(SANDBOX ? {} : STUB_ENV),
      PAYPAL_MODE: SANDBOX ? 'sandbox' : 'stub',
      DEMO_MODE: 'true',
      NODE_ENV: 'development',
    },
  },
});
