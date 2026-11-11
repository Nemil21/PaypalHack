import { z } from 'zod';

/**
 * Zod-validated environment (HF-001). Only DB, session and PayPal keys are required at boot;
 * feature keys are checked when the feature is first used, via `requireKeys()`.
 *
 * Error messages name keys only, never values: secrets must not reach logs.
 */

const SANDBOX_HOSTS = new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: 'must be true or false' });
      return z.NEVER;
    });

/** Like `bool`, but `undefined` when unset, so the default can depend on another key. */
const optionalBool = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return undefined;
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    ctx.addIssue({ code: 'custom', message: 'must be true or false' });
    return z.NEVER;
  });

const enumWithDefault = <T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : v.trim().toLowerCase()))
    .pipe(z.enum(values));

const httpUrl = z
  .string()
  .trim()
  .min(1, 'is required')
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

const required = z.string({ error: 'is required' }).trim().min(1, 'is required');

const envSchema = z.object({
  // Required at boot.
  DATABASE_URL: required.refine(
    (v) => /^postgres(ql)?:\/\//.test(v),
    'must be a postgres:// or postgresql:// URL',
  ),
  SESSION_SECRET: required.refine((v) => v.length >= 32, 'must be at least 32 characters'),
  PAYPAL_CLIENT_ID: required,
  PAYPAL_CLIENT_SECRET: required,
  PAYPAL_API_BASE: httpUrl,

  // Required only when the feature is used.
  CHANNEL3_API_KEY: optionalString,
  CHANNEL3_WEBHOOK_SECRET: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  AG_GRID_LICENSE_KEY: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  RENDER_API_KEY: optionalString,
  RENDER_WORKFLOWS_SERVICE_ID: optionalString,
  // Tasks are addressed as `<workflow slug>/<task name>` (HF-048a); the slug is on the task's
  // page in the Render dashboard and defaults to the Blueprint's workflow name.
  RENDER_WORKFLOW_SLUG: optionalString.transform((v) => v ?? 'holdfast-workflows'),
  APP_BASE_URL: optionalString.pipe(httpUrl.optional()),
  // Owner-role database URL for `demo:reset` only (HF-046): the truncate clears the append-only
  // audit log, which the app role cannot. CLI only; the web service never reads it.
  DEMO_ADMIN_DATABASE_URL: optionalString.refine(
    (v) => v === undefined || /^postgres(ql)?:\/\//.test(v),
    'must be a postgres:// or postgresql:// URL',
  ),
  PAYPAL_BRAND_EMAIL: optionalString,
  // HF-054b email: Resend. Without RESEND_API_KEY emails are logged to the console instead.
  RESEND_API_KEY: optionalString,
  // Sender, e.g. `Holdfast <alerts@yourdomain>` (a Resend-verified domain).
  EMAIL_FROM: optionalString,
  // HF-054b web push: VAPID key pair (`npm run vapid:keys`). Without both, push is off.
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  // VAPID contact: `mailto:` or https URL. Default mailto:alerts@holdfast.invalid.
  VAPID_SUBJECT: optionalString,

  // Flags.
  ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  DEMO_MODE: bool(false),
  PAYPAL_MODE: enumWithDefault(['sandbox', 'stub'] as const, 'sandbox'),
  PAYPAL_ENV: enumWithDefault(['sandbox', 'live'] as const, 'sandbox'),
  ALLOW_MOCK_DECLINE: bool(false),
  // The labelled "Use sandbox test card" button (HF-014b Part 1). Unset: follows DEMO_MODE.
  DEMO_TEST_CARD: optionalBool,
  CHANNEL3_MODE: enumWithDefault(['live', 'fixtures'] as const, 'live'),
  ROUNDS_TIME_SCALE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? '1' : v.trim()))
    .transform(Number)
    .pipe(z.number().positive('must be a positive number').max(100, 'must be <= 100')),
  SETTLEMENT_RUNNER: enumWithDefault(['inprocess', 'workflows'] as const, 'inprocess'),

  // Runtime.
  NODE_ENV: enumWithDefault(['development', 'test', 'production'] as const, 'development'),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? '3000' : v.trim()))
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
  HOST: optionalString.transform((v) => v ?? '0.0.0.0'),
  LOG_LEVEL: enumWithDefault(
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const,
    'info',
  ),
});

type ParsedEnv = z.infer<typeof envSchema>;

export interface Config extends Omit<ParsedEnv, 'DEMO_TEST_CARD'> {
  /** Resolved: `DEMO_TEST_CARD` if set, else `DEMO_MODE`; always false on a live base. */
  readonly DEMO_TEST_CARD: boolean;
  /** True when `PAYPAL_API_BASE` points at a PayPal sandbox host. */
  readonly paypalIsSandbox: boolean;
}

/** Keys that are optional at boot but required by a feature. */
export type FeatureKey =
  | 'CHANNEL3_API_KEY'
  | 'CHANNEL3_WEBHOOK_SECRET'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_MODEL'
  | 'AG_GRID_LICENSE_KEY'
  | 'PAYPAL_WEBHOOK_ID'
  | 'RENDER_API_KEY'
  | 'RENDER_WORKFLOWS_SERVICE_ID'
  | 'APP_BASE_URL'
  | 'PAYPAL_BRAND_EMAIL'
  | 'RESEND_API_KEY'
  | 'EMAIL_FROM'
  | 'VAPID_PUBLIC_KEY'
  | 'VAPID_PRIVATE_KEY';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class MissingFeatureConfigError extends Error {
  constructor(
    readonly feature: string,
    readonly missing: FeatureKey[],
  ) {
    super(
      `${feature} is not configured: set ${missing.join(', ')} in the environment (see .env.example).`,
    );
    this.name = 'MissingFeatureConfigError';
  }
}

export function isSandboxPayPalBase(base: string): boolean {
  try {
    const u = new URL(base);
    return u.protocol === 'https:' && SANDBOX_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Parse and validate an environment. Pure: pass `process.env` or a test object.
 * Throws `ConfigError` listing every problem (key names only).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(env)'} ${i.message}`);
    throw new ConfigError(
      `Invalid environment, refusing to boot:\n  - ${problems.join('\n  - ')}\nSee .env.example.`,
      problems,
    );
  }
  const parsed = result.data;
  const paypalIsSandbox = isSandboxPayPalBase(parsed.PAYPAL_API_BASE);

  // Live-base guard (feature 16): a non-sandbox PayPal base needs an explicit PAYPAL_ENV=live.
  if (!paypalIsSandbox && parsed.PAYPAL_ENV !== 'live') {
    const problem =
      'PAYPAL_API_BASE is not a PayPal sandbox host; set PAYPAL_ENV=live to use a live base';
    throw new ConfigError(`Invalid environment, refusing to boot:\n  - ${problem}`, [problem]);
  }

  return Object.freeze({
    ...parsed,
    // Mock declines are a sandbox-only demo aid: never allowed against a live base.
    ALLOW_MOCK_DECLINE: paypalIsSandbox ? parsed.ALLOW_MOCK_DECLINE : false,
    // The server-side test-card hold is a sandbox demo aid too.
    DEMO_TEST_CARD: paypalIsSandbox ? (parsed.DEMO_TEST_CARD ?? parsed.DEMO_MODE) : false,
    paypalIsSandbox,
  });
}

/**
 * Return the named feature keys, or throw `MissingFeatureConfigError` naming the missing ones.
 * Call this where the feature is used (e.g. the Channel3 client constructor), not at boot.
 */
export function requireKeys<K extends FeatureKey>(
  config: Config,
  feature: string,
  ...keys: K[]
): { [P in K]: string } {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) throw new MissingFeatureConfigError(feature, missing);
  return Object.fromEntries(keys.map((k) => [k, config[k] as string])) as { [P in K]: string };
}

/** Whether `PayPal-Mock-Response` may be sent (feature 16): only with DEMO_MODE + ALLOW_MOCK_DECLINE. */
export function mockDeclinesAllowed(config: Config): boolean {
  return config.paypalIsSandbox && config.DEMO_MODE && config.ALLOW_MOCK_DECLINE;
}

/**
 * Whether `paymentMethod: TEST_CARD` (the labelled "Use sandbox test card" button, HF-014b Part 1)
 * may place a server-side raw-card hold: `DEMO_TEST_CARD` on, and PayPal is the sandbox or the stub.
 */
export function testCardAllowed(config: Config): boolean {
  return config.DEMO_TEST_CARD && (config.paypalIsSandbox || config.PAYPAL_MODE === 'stub');
}

/** Case-insensitive admin check against `ADMIN_EMAILS`. */
export function isAdminEmail(config: Config, email: string | null | undefined): boolean {
  return !!email && config.ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

let cached: Config | undefined;

/** Process-wide config, loaded once from `process.env`. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}

/** For tests only. */
export function resetConfigCache(): void {
  cached = undefined;
}
