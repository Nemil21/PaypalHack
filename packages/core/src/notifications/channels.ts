import { sendNotification, WebPushError } from 'web-push';
import type { Config } from '../config.js';

/**
 * Delivery adapters for HF-054b's fan-out (features/13 §Channels): email through Resend (or the
 * console when no key is set, the demo / local default) and web push through VAPID. Both are
 * seams: tests pass fakes, and nothing here knows about templates or the database.
 *
 * Nothing logged here carries a secret or a full email address.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per delivery attempt target, so a retried send is not delivered twice (Resend). */
  idempotencyKey: string;
}

export interface EmailSender {
  readonly kind: 'resend' | 'console' | 'fake';
  /** Resolves when accepted; throws on failure (the fan-out retries). */
  send(email: OutgoingEmail): Promise<void>;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushResult = 'OK' | 'GONE';

export interface PushSender {
  /** `GONE` = the push service says the subscription no longer exists (404 / 410): revoke it. */
  send(sub: WebPushSubscription, payload: string): Promise<PushResult>;
}

export interface LineLogger {
  info(obj: object, msg: string): void;
}

/** "n***@example.com": enough to tell recipients apart in a log, not enough to read the address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function createResendEmailSender(opts: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): EmailSender {
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: 'resend',
    async send(email) {
      const res = await doFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: opts.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      // The status only: a Resend error body can echo the recipient.
      if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    },
  };
}

/** Demo / local: the email is "sent" to the log (features/13: console log in demo). */
export function createConsoleEmailSender(log: LineLogger): EmailSender {
  return {
    kind: 'console',
    async send(email) {
      log.info(
        // `body`, not `email`: the API logger redacts any field named email.
        { to: maskEmail(email.to), subject: email.subject, body: email.text },
        'email (console; set RESEND_API_KEY to send)',
      );
    },
  };
}

export const PUSH_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_VAPID_SUBJECT = 'mailto:alerts@holdfast.invalid';

export function createWebPushSender(opts: {
  publicKey: string;
  privateKey: string;
  subject?: string;
  timeoutMs?: number;
}): PushSender {
  const vapidDetails = {
    subject: opts.subject ?? DEFAULT_VAPID_SUBJECT,
    publicKey: opts.publicKey,
    privateKey: opts.privateKey,
  };
  return {
    async send(sub, payload) {
      try {
        await sendNotification(sub, payload, {
          vapidDetails,
          TTL: PUSH_TTL_SECONDS,
          urgency: 'high',
          timeout: opts.timeoutMs ?? 10_000,
        });
        return 'OK';
      } catch (err) {
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          return 'GONE';
        }
        // Drop headers / body / endpoint (a capability URL) from what reaches the logs.
        const status = err instanceof WebPushError ? err.statusCode : undefined;
        throw new Error(status ? `push service responded ${status}` : 'push send failed');
      }
    },
  };
}

/** Email: Resend when `RESEND_API_KEY` + `EMAIL_FROM` are set, else the console. */
export function emailSenderFromConfig(
  config: Pick<Config, 'RESEND_API_KEY' | 'EMAIL_FROM'>,
  log: LineLogger,
): EmailSender {
  return config.RESEND_API_KEY && config.EMAIL_FROM
    ? createResendEmailSender({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM })
    : createConsoleEmailSender(log);
}

/** Push: on when both VAPID keys are set; null (push off) otherwise. */
export function pushSenderFromConfig(
  config: Pick<Config, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>,
): PushSender | null {
  return config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
    ? createWebPushSender({
        publicKey: config.VAPID_PUBLIC_KEY,
        privateKey: config.VAPID_PRIVATE_KEY,
        subject: config.VAPID_SUBJECT,
      })
    : null;
}
