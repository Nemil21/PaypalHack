import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-020 E2E on the FakePayPal stub, continuing the HF-019 flow: offer page → test-card hold →
 * W13 confirmation → "Release if cheaper" toggle (off, then on above a dropped public price →
 * PRICE_DROP release, W21 + M06) → My bids tabs and cancel → each W21 variant from the
 * query-string fixture → 375 px swipe-to-cancel and pull-to-refresh.
 * Run like offer-page.spec.ts (see playwright.config.ts).
 */

const DB = process.env.E2E_DATABASE_URL;
const FIXTURE = fileURLToPath(new URL('../../../scripts/offer-fixture.mjs', import.meta.url));

test.skip(!DB, 'E2E_DATABASE_URL is not set');

function fixtureListing(): string {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  execFileSync('node', [FIXTURE, '--slug', slug, '--bids', '0'], {
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
  });
  return slug;
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

const bidRow = async (bidId: string) =>
  (
    await sql<{ status: string; void_reason: string | null; release_if_cheaper: boolean }>(
      `SELECT status, void_reason, release_if_cheaper FROM bids WHERE id = $1`,
      [bidId],
    )
  )[0]!;

/** Offer page → "Use sandbox test card" → `/bids/:id?held=1`; returns the bid id. */
async function hold(page: Page, slug: string): Promise<string> {
  await page.goto(`/o/${slug}`);
  await page.getByRole('button', { name: 'Use sandbox test card' }).click();
  await expect(page).toHaveURL(/\/bids\/[0-9a-f-]{36}\?held=1$/);
  return /\/bids\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

test('W13 confirmation → release-if-cheaper toggle → price-drop release (W21, timeline, M06)', async ({
  page,
}) => {
  const slug = fixtureListing();
  const bidId = await hold(page, slug);

  await expect(page.getByRole('heading', { name: '✓ $229 held, not charged' })).toBeVisible();
  await expect(page.getByText('What happens next')).toBeVisible();
  await expect(
    page.getByText("If you win, you're charged your bid of $229, exactly."),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Let my agent manage this/ })).toHaveAttribute(
    'href',
    /^\/mandates\/new\?productId=[0-9a-f-]{36}&maxPriceCents=22900$/,
  );
  await expect(page.getByRole('link', { name: 'View my bids' })).toBeVisible();

  const toggle = page.getByRole('switch').first();
  await expect(toggle).toHaveAttribute('aria-checked', 'true'); // on by default
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await bidRow(bidId)).release_if_cheaper).toBe(false);

  // A store drops to $219; switching the watch back on releases the $229 hold at once.
  await sql(
    `UPDATE products SET best_public_price_cents = 21900, price_updated_at = now()
      WHERE id = (SELECT product_id FROM listings WHERE slug = $1)`,
    [slug],
  );
  await page.getByRole('switch').first().click();
  await expect.poll(async () => (await bidRow(bidId)).status).toBe('VOIDED');
  expect((await bidRow(bidId)).void_reason).toBe('PRICE_DROP');

  const w21 = page.locator('[data-variant="price_dropped"]');
  await expect(w21.getByRole('heading', { name: 'Another store is $219 now.' })).toBeVisible();
  await expect(
    w21.getByText('We released your $229 hold. Your bank may show it as pending for a few days.'),
  ).toBeVisible();
  await expect(w21.getByRole('link', { name: 'Buy at retailer.example $219' })).toBeVisible();
  await expect(w21.getByText(/We may earn a commission/)).toBeVisible();

  await expect(page.getByText('Price dropped: $219 at retailer.example')).toBeVisible();
  await expect(page.getByText('Held $229 → released')).toBeVisible();
  await page.getByRole('button', { name: 'See the cheaper offer' }).click();
  const sheet = page.getByRole('dialog', { name: 'The price dropped' });
  await expect(sheet.getByText('Hold released')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);

  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/got it at/i);
  expect(text).not.toMatch(/charged \$/i);
});

test('My bids: Live tab, cancel with confirm → Released tab with reason', async ({ page }) => {
  const slug = fixtureListing();
  const bidId = await hold(page, slug);
  await page.getByRole('link', { name: 'View my bids' }).click();
  await expect(page).toHaveURL(/\/bids$/);
  await expect(page.getByRole('tab', { name: /Live/ })).toHaveAttribute('aria-selected', 'true');
  const card = page.getByRole('article').filter({ has: page.locator(`a[href="/bids/${bidId}"]`) });
  await expect(card.getByText('$229 held, not charged')).toBeVisible();
  await expect(card.getByText('via offer page')).toBeVisible();
  await expect(card.getByText(/Closes in/)).toBeVisible();

  await card.getByRole('button', { name: 'Cancel bid' }).click();
  await expect(card.getByText('Release your $229 hold?')).toBeVisible();
  await card.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(card).toHaveCount(0);

  await page.getByRole('tab', { name: /Released/ }).click();
  const released = page
    .getByRole('article')
    .filter({ has: page.locator(`a[href="/bids/${bidId}"]`) });
  await expect(released.getByText('You cancelled it.')).toBeVisible();
  await expect(
    released.getByText(/Your bank may show it as pending for a few days\./),
  ).toBeVisible();
});

test('each W21 variant renders from its error code (query-string fixture)', async ({ page }) => {
  const cases: Array<[string, string, RegExp]> = [
    ['WINDOW_CLOSED', 'window_closed', /This window has closed\./],
    ['HOLD_FAILED', 'hold_failed', /PayPal couldn't hold \$229\./],
    ['PRICE_DROP', 'price_dropped', /Another store is \$219 now\./],
    ['CAPTURE_FAILED', 'declined', /Your card was declined/],
    ['ABOVE_MANDATE_MAX', 'above_mandate', /above the \$230 limit/],
    ['NOT_FOUND', 'not_found', /couldn't find that/],
    ['UNAUTHENTICATED', 'session_expired', /session expired/],
  ];
  for (const [code, variant, title] of cases) {
    await page.goto(`/dev/states?code=${code}`);
    const el = page.locator(`[data-variant="${variant}"]`);
    await expect(el).toHaveCount(1);
    await expect(el.getByRole('heading')).toHaveText(title);
  }
  // A real bid page takes `?error=` from the PayPal return the same way.
  const slug = fixtureListing();
  const bidId = await hold(page, slug);
  await page.goto(`/bids/${bidId}?error=HOLD_FAILED`);
  await expect(page.locator('[data-variant="hold_failed"]')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try another method' })).toHaveAttribute(
    'href',
    `/o/${slug}?amount=22900`,
  );
});

test.describe('375 px (M02 / M03 / M04)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  async function touch(page: Page, points: Array<[number, number]>) {
    const cdp = await page.context().newCDPSession(page);
    const [first, ...rest] = points;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: first![0], y: first![1] }],
    });
    for (const [x, y] of rest) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  test('no horizontal scroll; sticky Raise / Cancel; swipe-to-cancel; pull-to-refresh', async ({
    page,
  }) => {
    const slug = fixtureListing();
    const bidId = await hold(page, slug);
    const noOverflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await noOverflow()).toBeLessThanOrEqual(0);

    await page.goto(`/bids/${bidId}`);
    const raise = page.getByRole('link', { name: 'Raise', exact: true });
    await expect(raise).toBeVisible();
    const box = await raise.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThan(812 - 80); // M04 sticky bar
    expect(await noOverflow()).toBeLessThanOrEqual(0);

    await page.goto('/bids');
    const card = page
      .getByRole('article')
      .filter({ has: page.locator(`a[href="/bids/${bidId}"]`) });
    await expect(card).toBeVisible();
    expect(await noOverflow()).toBeLessThanOrEqual(0);

    // Pull to refresh: drag down from the top → GET /api/bids/mine again.
    const refreshed = page.waitForRequest((r) => r.url().endsWith('/api/bids/mine'));
    await touch(page, [
      [187, 120],
      [187, 160],
      [187, 220],
      [187, 300],
    ]);
    await refreshed;

    // Swipe left → cancel confirm (never cancels without it).
    const cb = (await card.boundingBox())!;
    const y = cb.y + 30;
    await touch(page, [
      [cb.x + cb.width - 20, y],
      [cb.x + cb.width - 60, y + 2],
      [cb.x + cb.width - 120, y + 2],
      [cb.x + cb.width - 180, y + 3],
    ]);
    await expect(card.getByText('Release your $229 hold?')).toBeVisible();
    expect((await bidRow(bidId)).status).toBe('HELD');
    await card.getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect.poll(async () => (await bidRow(bidId)).status).toMatch(/^VOID(ING|ED)$/);
  });
});
