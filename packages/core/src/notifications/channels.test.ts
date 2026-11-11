import { describe, expect, it } from 'vitest';
import {
  createConsoleEmailSender,
  createResendEmailSender,
  emailSenderFromConfig,
  maskEmail,
  pushSenderFromConfig,
  RESEND_ENDPOINT,
} from './channels.js';

const email = {
  to: 'sam@example.com',
  subject: 'You won',
  text: 'You won at your bid of $229. Charged $229.',
  html: '<p>You won</p>',
  idempotencyKey: 'row-1:0',
};

describe('HF-054b email senders', () => {
  it('Resend: one POST with the key as bearer and the row as Idempotency-Key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createResendEmailSender({
      apiKey: 're_test',
      from: 'Holdfast <alerts@example.com>',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{"id":"x"}', { status: 200 });
      }) as typeof fetch,
    });
    await sender.send(email);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_ENDPOINT);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    expect(headers['idempotency-key']).toBe('row-1:0');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: 'Holdfast <alerts@example.com>',
      to: ['sam@example.com'],
      subject: 'You won',
      text: email.text,
      html: email.html,
    });
  });

  it('Resend: a failure throws the status only (no echoed body)', async () => {
    const sender = createResendEmailSender({
      apiKey: 're_test',
      from: 'a@b.c',
      fetch: (async () =>
        new Response('{"message":"sam@example.com is invalid"}', { status: 422 })) as typeof fetch,
    });
    await expect(sender.send(email)).rejects.toThrow(/^Resend responded 422$/);
  });

  it('console: logs the email with a masked address', async () => {
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    await createConsoleEmailSender({
      info: (obj, msg) => lines.push({ obj: obj as never, msg }),
    }).send(email);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ to: 's***@example.com', subject: 'You won' });
    expect(JSON.stringify(lines)).not.toContain('sam@example.com');
    expect(String(lines[0]!.obj.body)).toContain('Charged $229.');
  });

  it('maskEmail', () => {
    expect(maskEmail('nemil@x.io')).toBe('n***@x.io');
    expect(maskEmail('nope')).toBe('***');
  });

  it('config selects Resend only with key and sender; push only with both VAPID keys', () => {
    const log = { info() {} };
    expect(
      emailSenderFromConfig({ RESEND_API_KEY: undefined, EMAIL_FROM: 'a@b.c' }, log).kind,
    ).toBe('console');
    expect(emailSenderFromConfig({ RESEND_API_KEY: 'k', EMAIL_FROM: undefined }, log).kind).toBe(
      'console',
    );
    expect(emailSenderFromConfig({ RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' }, log).kind).toBe(
      'resend',
    );
    expect(
      pushSenderFromConfig({
        VAPID_PUBLIC_KEY: 'p',
        VAPID_PRIVATE_KEY: undefined,
        VAPID_SUBJECT: undefined,
      }),
    ).toBeNull();
    expect(
      pushSenderFromConfig({
        VAPID_PUBLIC_KEY: 'p',
        VAPID_PRIVATE_KEY: 's',
        VAPID_SUBJECT: undefined,
      }),
    ).not.toBeNull();
  });
});
