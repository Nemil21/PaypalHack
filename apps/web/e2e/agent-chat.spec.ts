import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import pg from 'pg';

/**
 * HF-041 E2E on the FakePayPal stub (run like offer-page.spec.ts; see playwright.config.ts).
 *  1. 375 px: the recorded turn (`/agent?fixture=1`) → chips, product card, the confirm card as a
 *     bottom sheet → Approve → "held, not charged"; nothing overflows sideways.
 *  2. Real server: the chat stream is stubbed (no model call) but the pending action is a real
 *     row, so "Approve" hits the real `POST /api/agent/actions/:id/confirm`. With no saved card
 *     it answers NEEDS_PAYMENT_METHOD → "Continue on the offer page" (W12 prefilled with the
 *     stored $229) → test-card hold → HELD in W14 and in the desktop side panel.
 */

const DB = process.env.E2E_DATABASE_URL;
const FIXTURE = fileURLToPath(new URL('../../../scripts/offer-fixture.mjs', import.meta.url));

test.skip(!DB, 'E2E_DATABASE_URL is not set');

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

test.describe('phone (375 px), recorded stream', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('ask → proposal with the Channel3 price → approve → held', async ({ page }) => {
    await page.goto('/agent?fixture=1');
    await expect(page.getByText('Recorded demo')).toBeVisible();
    await page.getByRole('button', { name: 'Aurel headphones under $230' }).click();

    // Chips collapse to one summary chip on phones.
    await expect(page.getByTestId('tool-chips').first().locator('summary')).toContainText(
      'Checked 14 stores',
    );
    await expect(page.getByText('Channel3 · bestbuy.com')).toBeVisible();

    const sheet = page.getByRole('dialog');
    await expect(sheet.getByTestId('confirm-amount')).toHaveText('Bid $229');
    await expect(sheet).toContainText('Aurel A7 Wireless Noise Cancelling Headphones');
    const box = await sheet.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThan(800); // pinned to the bottom (M05)

    await sheet.getByRole('button', { name: 'Approve with PayPal' }).click();
    await expect(page.getByText('$229 held, not charged.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test('real confirm: no saved card → offer page prefilled → HELD in W14 and the side panel', async ({
  page,
}) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  execFileSync('node', [FIXTURE, '--slug', slug, '--bids', '0'], {
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
  });
  const [listing] = await sql<{ id: string }>(`SELECT id FROM listings WHERE slug = $1`, [slug]);

  // Signed out → demo shopper.
  await page.goto('/agent');
  await page.getByRole('button', { name: 'Continue as demo shopper' }).click();
  await expect(page.getByRole('button', { name: 'Aurel headphones under $230' })).toBeVisible();
  const me = (await (await page.request.get('/api/me')).json()) as { shopper: { id: string } };
  const shopperId = me.shopper.id;
  await sql(`UPDATE shoppers SET paypal_vault_id = NULL WHERE id = $1`, [shopperId]);

  // The pending action HF-039's place_bid would have stored.
  const [conv] = await sql<{ id: string }>(
    `INSERT INTO agent_conversations (shopper_id, title) VALUES ($1, 'e2e') RETURNING id`,
    [shopperId],
  );
  const [action] = await sql<{ id: string; expires_at: Date }>(
    `INSERT INTO agent_pending_actions (conversation_id, shopper_id, tool, args, expires_at)
     VALUES ($1, $2, 'place_bid', $3, now() + interval '10 minutes') RETURNING id, expires_at`,
    [conv!.id, shopperId, JSON.stringify({ listingId: listing!.id, amountCents: 22_900 })],
  );

  const events = [
    { type: 'tool_call', id: 't1', name: 'place_bid', input: {} },
    {
      type: 'tool_result',
      id: 't1',
      name: 'place_bid',
      ok: true,
      result: { confirmRequired: true, actionId: action!.id, amountCents: 22_900 },
    },
    // Model prose with another number: the card must not use it.
    { type: 'text', text: 'Bid $500 in this book?' },
    {
      type: 'confirm_required',
      actionId: action!.id,
      tool: 'place_bid',
      amountCents: 22_900,
      amountFormatted: '$229',
      product: { title: 'E2E product', imageUrl: null },
      listing: { id: listing!.id, slug, brandName: 'E2E Brand' },
      confirmMode: 'INLINE',
      offerUrl: null,
      expiresAt: new Date(action!.expires_at).toISOString(),
    },
    { type: 'done', conversationId: conv!.id, reason: 'confirm_required' },
  ];
  await page.route('**/api/agent/chat', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-conversation-id': conv!.id },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
    }),
  );

  await page.getByRole('button', { name: 'Aurel headphones under $230' }).click();
  await expect(page.getByTestId('confirm-amount')).toHaveText('Bid $229');
  await page.getByRole('button', { name: 'Approve with PayPal' }).click();

  const cont = page.getByRole('link', { name: 'Continue on the offer page' });
  await expect(cont).toHaveAttribute('href', `/o/${slug}?amount=22900&src=agent`);
  expect(
    (await sql(`SELECT status FROM agent_pending_actions WHERE id = $1`, [action!.id]))[0],
  ).toEqual({ status: 'PENDING' });

  await cont.click();
  await page.getByRole('button', { name: 'Use sandbox test card' }).click();
  await expect(page).toHaveURL(/\/bids\/[0-9a-f-]{36}\?held=1$/);
  const bidId = /\/bids\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const [bid] = await sql<{ amount_cents: number; status: string; listing_id: string }>(
    `SELECT amount_cents, status, listing_id FROM bids WHERE id = $1`,
    [bidId],
  );
  expect(bid).toEqual({ amount_cents: 22_900, status: 'HELD', listing_id: listing!.id });

  // W14 shows the HELD row; so does the agent side panel on desktop.
  await page.goto('/bids');
  await expect(page.getByText('$229').first()).toBeVisible();
  await page.goto('/agent');
  await expect(page.getByTestId('side-live-bids')).toContainText('$229');
});
