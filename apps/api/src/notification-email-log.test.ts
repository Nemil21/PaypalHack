import { describe, expect, it } from 'vitest';
import { createConsoleEmailSender } from '@holdfast/core';
import { notificationEmail, NOTIFICATION_SAMPLES } from '@holdfast/shared';
import { redactValue } from './http/redact.js';

describe('HF-054b console email through the API log redaction', () => {
  it('won keeps its D14 copy; the address stays masked', async () => {
    const lines: unknown[] = [];
    const sender = createConsoleEmailSender({ info: (obj) => lines.push(redactValue(obj)) });
    const msg = notificationEmail('won', NOTIFICATION_SAMPLES.won);
    await sender.send({ to: 'sam@example.com', ...msg, idempotencyKey: 'k' });
    const logged = lines[0] as { to: string; subject: string; body: string };
    expect(logged.subject).toBe('You won');
    expect(logged.body).toContain('You won at your bid of $229. Charged $229.');
    expect(JSON.stringify(logged)).not.toContain('sam@example.com');
  });
});
