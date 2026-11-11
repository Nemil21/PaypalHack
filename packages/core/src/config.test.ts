import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  MissingFeatureConfigError,
  isAdminEmail,
  isSandboxPayPalBase,
  loadConfig,
  mockDeclinesAllowed,
  requireKeys,
} from './config.js';

// Obviously fake values; never real credentials in tests.
const SECRET_SENTINEL = 'test-client-secret-should-never-appear-in-errors';
const REQUIRED = {
  DATABASE_URL: 'postgres://holdfast:pw@localhost:5432/holdfast',
  SESSION_SECRET: 'x'.repeat(32),
  PAYPAL_CLIENT_ID: 'test-client-id',
  PAYPAL_CLIENT_SECRET: SECRET_SENTINEL,
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
};

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig: required keys', () => {
  it('boots with only the five required keys and applies defaults', () => {
    const c = loadConfig({ ...REQUIRED });
    expect(c.paypalIsSandbox).toBe(true);
    expect(c.PAYPAL_MODE).toBe('sandbox');
    expect(c.PAYPAL_ENV).toBe('sandbox');
    expect(c.SETTLEMENT_RUNNER).toBe('inprocess');
    expect(c.CHANNEL3_MODE).toBe('live');
    expect(c.DEMO_MODE).toBe(false);
    expect(c.ALLOW_MOCK_DECLINE).toBe(false);
    expect(c.ROUNDS_TIME_SCALE).toBe(1);
    expect(c.ADMIN_EMAILS).toEqual([]);
    expect(c.PORT).toBe(3000);
    expect(c.CHANNEL3_API_KEY).toBeUndefined();
    expect(Object.isFrozen(c)).toBe(true);
  });

  it.each(Object.keys(REQUIRED))('fails fast when %s is missing', (key) => {
    const env: Record<string, string | undefined> = { ...REQUIRED, [key]: undefined };
    const err = errorOf(() => loadConfig(env));
    expect(err.problems.some((p) => p.startsWith(key))).toBe(true);
    expect(err.message).toContain(key);
    expect(err.message).toContain('.env.example');
  });

  it('treats a blank required value as missing', () => {
    const err = errorOf(() => loadConfig({ ...REQUIRED, PAYPAL_CLIENT_ID: '   ' }));
    expect(err.message).toMatch(/PAYPAL_CLIENT_ID is required/);
  });

  it('reports every problem at once', () => {
    const err = errorOf(() => loadConfig({}));
    expect(err.problems).toHaveLength(5);
  });

  it.each<[string, Record<string, string>]>([
    ['non-postgres DATABASE_URL', { DATABASE_URL: 'mysql://x' }],
    ['short SESSION_SECRET', { SESSION_SECRET: 'short' }],
    ['bad PAYPAL_API_BASE', { PAYPAL_API_BASE: 'not a url' }],
    ['bad PAYPAL_MODE', { PAYPAL_MODE: 'prod' }],
    ['bad SETTLEMENT_RUNNER', { SETTLEMENT_RUNNER: 'cron' }],
    ['bad CHANNEL3_MODE', { CHANNEL3_MODE: 'mock' }],
    ['bad DEMO_MODE', { DEMO_MODE: 'maybe' }],
    ['zero ROUNDS_TIME_SCALE', { ROUNDS_TIME_SCALE: '0' }],
    ['non-numeric ROUNDS_TIME_SCALE', { ROUNDS_TIME_SCALE: 'fast' }],
    ['bad PORT', { PORT: '70000' }],
    ['bad APP_BASE_URL', { APP_BASE_URL: 'holdfast.example' }],
  ])('rejects %s', (_name, over) => {
    expect(() => loadConfig({ ...REQUIRED, ...over })).toThrow(ConfigError);
  });

  it('never puts secret values in the error', () => {
    const err = errorOf(() =>
      loadConfig({
        ...REQUIRED,
        SESSION_SECRET: 'tiny',
        PAYPAL_API_BASE: 'https://api-m.paypal.com',
      }),
    );
    expect(err.message).not.toContain(SECRET_SENTINEL);
    expect(err.message).not.toContain('tiny');
    expect(err.message).not.toContain('pw@');
  });

  it('parses flags', () => {
    const c = loadConfig({
      ...REQUIRED,
      ADMIN_EMAILS: ' Ops@Holdfast.dev, , judge@example.com ',
      DEMO_MODE: 'true',
      ALLOW_MOCK_DECLINE: '1',
      PAYPAL_MODE: 'STUB',
      CHANNEL3_MODE: 'fixtures',
      ROUNDS_TIME_SCALE: '0.0667',
      SETTLEMENT_RUNNER: 'workflows',
    });
    expect(c.ADMIN_EMAILS).toEqual(['ops@holdfast.dev', 'judge@example.com']);
    expect(c.DEMO_MODE).toBe(true);
    expect(c.ALLOW_MOCK_DECLINE).toBe(true);
    expect(c.PAYPAL_MODE).toBe('stub');
    expect(c.CHANNEL3_MODE).toBe('fixtures');
    expect(c.ROUNDS_TIME_SCALE).toBeCloseTo(0.0667);
    expect(c.SETTLEMENT_RUNNER).toBe('workflows');
    expect(isAdminEmail(c, 'OPS@holdfast.dev ')).toBe(true);
    expect(isAdminEmail(c, 'someone@else.com')).toBe(false);
    expect(isAdminEmail(c, null)).toBe(false);
    expect(mockDeclinesAllowed(c)).toBe(true);
  });
});

describe('loadConfig: live PayPal base guard', () => {
  const LIVE = 'https://api-m.paypal.com';

  it('refuses a live base without PAYPAL_ENV=live', () => {
    const err = errorOf(() => loadConfig({ ...REQUIRED, PAYPAL_API_BASE: LIVE }));
    expect(err.message).toMatch(/not a PayPal sandbox host.*PAYPAL_ENV=live/);
  });

  it.each([
    'https://evil.example.com',
    'http://api-m.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com.evil.io',
  ])('treats %s as non-sandbox', (base) => {
    expect(isSandboxPayPalBase(base)).toBe(false);
    expect(() => loadConfig({ ...REQUIRED, PAYPAL_API_BASE: base })).toThrow(ConfigError);
  });

  it('accepts both sandbox hosts', () => {
    expect(isSandboxPayPalBase('https://api-m.sandbox.paypal.com')).toBe(true);
    expect(isSandboxPayPalBase('https://api.sandbox.paypal.com/')).toBe(true);
  });

  it('boots against a live base with PAYPAL_ENV=live and forces ALLOW_MOCK_DECLINE off', () => {
    const c = loadConfig({
      ...REQUIRED,
      PAYPAL_API_BASE: LIVE,
      PAYPAL_ENV: 'live',
      DEMO_MODE: 'true',
      ALLOW_MOCK_DECLINE: 'true',
    });
    expect(c.paypalIsSandbox).toBe(false);
    expect(c.ALLOW_MOCK_DECLINE).toBe(false);
    expect(mockDeclinesAllowed(c)).toBe(false);
  });

  it('mock declines need DEMO_MODE too', () => {
    const c = loadConfig({ ...REQUIRED, ALLOW_MOCK_DECLINE: 'true' });
    expect(mockDeclinesAllowed(c)).toBe(false);
  });
});

describe('requireKeys: optional keys fail only when the feature is used', () => {
  it('boot succeeds without feature keys; the feature call fails with a clear message', () => {
    const c = loadConfig({ ...REQUIRED });
    expect(() => requireKeys(c, 'Channel3', 'CHANNEL3_API_KEY', 'CHANNEL3_WEBHOOK_SECRET')).toThrow(
      new MissingFeatureConfigError('Channel3', ['CHANNEL3_API_KEY', 'CHANNEL3_WEBHOOK_SECRET']),
    );
    try {
      requireKeys(c, 'Claude API', 'ANTHROPIC_API_KEY');
    } catch (e) {
      expect((e as Error).message).toBe(
        'Claude API is not configured: set ANTHROPIC_API_KEY in the environment (see .env.example).',
      );
    }
  });

  it('names only the missing keys and returns present ones', () => {
    const c = loadConfig({ ...REQUIRED, CHANNEL3_API_KEY: 'k' });
    expect(() => requireKeys(c, 'Channel3', 'CHANNEL3_API_KEY', 'CHANNEL3_WEBHOOK_SECRET')).toThrow(
      /set CHANNEL3_WEBHOOK_SECRET in/,
    );
    expect(requireKeys(c, 'Channel3 search', 'CHANNEL3_API_KEY')).toEqual({
      CHANNEL3_API_KEY: 'k',
    });
  });

  it('treats blank optional keys as unset', () => {
    const c = loadConfig({ ...REQUIRED, ANTHROPIC_API_KEY: '' });
    expect(c.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
