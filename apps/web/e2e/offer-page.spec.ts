import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-019 E2E on the FakePayPal stub: offer page → "Use sandbox test card" → confirmation route,
 * then the offer page's already-bid state; double click → one bid; over-public warning; 375 px.
 * See playwright.config.ts for how to run it. Card fields: E2E_PAYPAL=sandbox (+ HF-014b).
 */

const DB = process.env.E2E_DATABASE_URL;
const FIXTURE = fileURLToPath(new URL('../../../scripts/offer-fixture.mjs', import.meta.url));

test.skip(!DB, 'E2E_DATABASE_URL is not set');

function fixtureListing(bids = 12): string {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  execFileSync('node', [FIXTURE, '--slug', slug, '--bids', String(bids)], {
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

const bidsFor = (slug: string) =>
  sql<{ status: string; amount_cents: number; release_if_cheaper: boolean }>(
    `SELECT b.status, b.amount_cents, b.release_if_cheaper FROM bids b JOIN listings l ON l.id = b.listing_id
      WHERE l.slug = $1 AND b.source = 'OFFER_PAGE'`,
    [slug],
  );

async function openOffer(page: Page, slug: string) {
  await page.goto(`/o/${slug}`);
  await expect(page.getByRole('heading', { name: /Aurel A7 Wireless/ })).toBeVisible();
}

test('test-card hold → confirmation route → already-bid state; floor never in the DOM', async ({
  page,
}) => {
  const slug = fixtureListing();
  await openOffer(page, slug);
  await expect(page.getByText('Verified brand')).toBeVisible();
  await expect(page.getByText('Cheapest public price $279 at retailer.example')).toBeVisible();
  await expect(page.getByLabel('Your price', { exact: true })).toHaveValue('229');
  await expect(page.getByText(/are most likely to clear/)).toBeVisible();
  await expect(page.getByText(/Window closes in/)).toBeVisible();

  const html = await page.content();
  expect(html).not.toMatch(/floor/i);
  expect(html).not.toContain('$198'); // fixture floor

  await page.getByRole('button', { name: 'Use sandbox test card' }).click();
  await expect(page).toHaveURL(/\/bids\/[0-9a-f-]{36}\?held=1$/);
  expect(await bidsFor(slug)).toEqual([
    { status: 'HELD', amount_cents: 22_900, release_if_cheaper: true },
  ]);

  await openOffer(page, slug);
  await expect(page.getByText('$229', { exact: true })).toBeVisible();
  await expect(page.getByText('Held · not charged')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel bid' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use sandbox test card' })).toHaveCount(0);

  // Cancel (HF-016): the hold is released and the bid form comes back.
  await page.getByRole('button', { name: 'Cancel bid' }).click();
  await expect(page.getByText('Release your $229 hold?')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByRole('button', { name: 'Use sandbox test card' })).toBeVisible();
  const [bid] = await bidsFor(slug);
  expect(['VOIDING', 'VOIDED']).toContain(bid!.status);
});

test('double click → one bid', async ({ page }) => {
  const slug = fixtureListing(0);
  await openOffer(page, slug);
  await page.getByRole('button', { name: 'Use sandbox test card' }).dblclick();
  await expect(page).toHaveURL(/\?held=1$/);
  expect(await bidsFor(slug)).toHaveLength(1);
});

test('above the public price: warning, then releaseIfCheaper=false', async ({ page }) => {
  const slug = fixtureListing(0);
  await openOffer(page, slug);
  const input = page.getByLabel('Your price', { exact: true });
  await input.fill('289');
  await page.getByRole('button', { name: 'Use sandbox test card' }).click();
  await expect(
    page.getByText('Another store sells it for $279 today. Still bid $289?'),
  ).toBeVisible();
  await expect(page.getByText("We won't release this bid for a cheaper store.")).toBeVisible();
  expect(await bidsFor(slug)).toHaveLength(0);
  await page.getByRole('button', { name: 'Still bid $289' }).click();
  await expect(page).toHaveURL(/\?held=1$/);
  expect(await bidsFor(slug)).toEqual([
    { status: 'HELD', amount_cents: 28_900, release_if_cheaper: false },
  ]);
});

test('?amount= deep link prefills the price', async ({ page }) => {
  const slug = fixtureListing(0);
  await page.goto(`/o/${slug}?amount=21500&src=agent`);
  await expect(page.getByLabel('Your price', { exact: true })).toHaveValue('215');
});

test.describe('375 px (M01)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('no horizontal scroll; stepper; sticky hold bar', async ({ page }) => {
    const slug = fixtureListing();
    await openOffer(page, slug);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Raise by $5' }).click();
    await expect(page.getByLabel('Your price', { exact: true })).toHaveValue('234');
    const bar = page.getByRole('button', { name: 'Hold $234 with PayPal' });
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThan(812 - 80); // pinned to the bottom
  });
});

test('card fields hold (sandbox only)', async ({ page }) => {
  test.skip(process.env.E2E_PAYPAL !== 'sandbox', 'needs the PayPal sandbox and HF-014b');
  const slug = fixtureListing(0);
  await openOffer(page, slug);
  await page.getByRole('radio', { name: 'Card' }).click();
  const frame = (label: string) =>
    page.getByLabel(label).frameLocator('iframe').locator('input').first();
  await frame('Card number').fill('4111111111111111');
  await frame('Expiry').fill('12/30');
  await frame('Security code').fill('123');
  await frame('Name on card').fill('Holdfast Sandbox');
  await page.getByRole('button', { name: 'Hold $229 with card' }).click();
  await expect(page).toHaveURL(/\?held=1$/, { timeout: 45_000 });
});
