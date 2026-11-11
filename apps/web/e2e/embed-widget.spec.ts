import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-055 E2E on the FakePayPal stub (acceptance criteria):
 *   - the widget renders on the labelled mock Aurel Audio store page and opens the offer flow in a
 *     new tab, where a test-card hold completes; the bid carries the source (`utm_source`);
 *   - the same from a different origin (a brand's own site), so the CORS status check and the
 *     first-party tab are real;
 *   - a closed listing shows "Offers closed";
 *   - W10 shows the link, snippet, preview and the stats by source.
 * See playwright.config.ts for how to run it.
 */

const DB = process.env.E2E_DATABASE_URL;
const FIXTURE = fileURLToPath(new URL('../../../scripts/offer-fixture.mjs', import.meta.url));

test.skip(!DB, 'E2E_DATABASE_URL is not set');

// Both origins are loopback here, and Chrome's Local/Private Network Access checks refuse a
// page loading a script from another loopback origin without a permission prompt. A deployed
// app is on a public host, where these checks don't apply; turn them off for this file (the
// other tests are same-origin).
test.use({
  launchOptions: {
    args: [
      '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
    ],
  },
});

function fixtureListing(): string {
  const slug = `e2e-embed-${randomUUID().slice(0, 8)}`;
  execFileSync('node', [FIXTURE, '--slug', slug, '--bids', '3'], {
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

const offerPageBids = (slug: string) =>
  sql<{ status: string; utm_source: string | null }>(
    `SELECT b.status, b.utm_source FROM bids b JOIN listings l ON l.id = b.listing_id
      WHERE l.slug = $1 AND b.source = 'OFFER_PAGE'`,
    [slug],
  );

const clicks = (slug: string) =>
  sql<{ data: { source: string; medium: string | null } }>(
    `SELECT a.data FROM audit_events a JOIN listings l ON l.id = a.listing_id
      WHERE l.slug = $1 AND a.action = 'OFFER_CLICK' ORDER BY a.id`,
    [slug],
  );

/** Click the widget button; the offer page opens in a new tab. */
async function openFromWidget(context: BrowserContext, page: Page): Promise<Page> {
  const button = page.getByRole('link', { name: 'Make an offer' });
  await expect(button).toBeVisible();
  const [tab] = await Promise.all([context.waitForEvent('page'), button.click()]);
  await tab.waitForLoadState();
  return tab;
}

async function holdWithTestCard(tab: Page) {
  await expect(tab.getByRole('heading', { name: /Aurel A7 Wireless/ })).toBeVisible();
  await tab.getByRole('button', { name: 'Use sandbox test card' }).click();
  await expect(tab).toHaveURL(/\/bids\/[0-9a-f-]{36}\?held=1$/);
}

test('mock store page: widget → new tab → test-card hold, attributed to the source', async ({
  context,
  page,
}) => {
  const slug = fixtureListing();
  await page.goto(`/demo/aurel-store.html?listing=${slug}&source=email`);
  await expect(page.getByText(/MOCK STORE for the Holdfast demo/)).toBeVisible();
  await expect(page.locator('.hf-offer')).toHaveAttribute('data-state', 'open');

  const tab = await openFromWidget(context, page);
  expect(new URL(tab.url()).pathname).toBe(`/o/${slug}`);
  expect(new URL(tab.url()).searchParams.get('utm_source')).toBe('email');
  expect(new URL(tab.url()).searchParams.get('utm_medium')).toBe('widget');
  await expect(tab.getByRole('banner')).toBeVisible(); // a normal tab, not embed mode
  await holdWithTestCard(tab);

  expect(await offerPageBids(slug)).toEqual([{ status: 'HELD', utm_source: 'email' }]);
  // Reloading the offer page in the same tab is the same visit: still one click.
  await tab.goto(`/o/${slug}?utm_source=email&utm_medium=widget`);
  await expect(tab.getByText('Held · not charged')).toBeVisible();
  expect(await clicks(slug)).toEqual([{ data: { source: 'email', medium: 'widget' } }]);
});

test("a brand's own site (another origin): the button checks status and opens a first-party tab", async ({
  context,
  page,
  baseURL,
}) => {
  const slug = fixtureListing();
  // Another origin than the app (localhost vs 127.0.0.1), standing in for the brand's site.
  const brandSite = `http://localhost:${new URL(baseURL!).port}/__mock-brand-site`;
  await page.route(`${brandSite}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Aurel A7 (mock brand site)</title><h1>Aurel A7 Wireless</h1>
        <script src="${baseURL}/widget.js" data-listing="${slug}" data-theme="dark" async></script>`,
    }),
  );
  await page.goto(`${brandSite}/products/a7`);
  await expect(page.locator('.hf-offer')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('.hf-offer')).toHaveAttribute('data-theme', 'dark');

  const tab = await openFromWidget(context, page);
  expect(new URL(tab.url()).origin).toBe(new URL(baseURL!).origin);
  await holdWithTestCard(tab);
  expect(await offerPageBids(slug)).toEqual([{ status: 'HELD', utm_source: 'widget' }]);
});

test('closed listing: "Offers closed", nothing to click', async ({ page }) => {
  const slug = fixtureListing();
  await sql(`UPDATE listings SET window_closes_at = now() - interval '1 minute' WHERE slug = $1`, [
    slug,
  ]);
  await page.goto(`/demo/aurel-store.html?listing=${slug}`);
  await expect(page.locator('.hf-offer')).toHaveAttribute('data-state', 'closed');
  const closed = page.getByRole('link', { name: 'Offers closed' });
  await expect(closed).toHaveAttribute('aria-disabled', 'true');
  await expect(closed).not.toHaveAttribute('href', /.*/);
});

test('W10: link with source, QR, snippet, mock preview and stats by source', async ({ page }) => {
  await page.goto('/');
  const brandId = await page.evaluate(async () => {
    const r = await fetch('/api/auth/demo/brand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ role: 'OWNER' }),
    });
    return ((await r.json()) as { brandUser: { brand: { id: string } } }).brandUser.brand.id;
  });
  const slug = fixtureListing();
  await sql(`UPDATE listings SET brand_id = $1 WHERE slug = $2`, [brandId, slug]);
  await sql(
    `UPDATE products p SET title = 'Embed E2E ' || $1 FROM listings l
              WHERE l.product_id = p.id AND l.slug = $1`,
    [slug],
  );

  // One tracked visit from an email link.
  await page.goto(`/o/${slug}?utm_source=email`);
  await expect(page.getByRole('button', { name: 'Use sandbox test card' })).toBeVisible();
  await expect.poll(async () => (await clicks(slug)).length).toBe(1);

  await page.goto('/brand/embed');
  await expect(page.getByRole('heading', { name: 'Embed & share' })).toBeVisible();
  await page.getByLabel('Listing').selectOption({ label: `Embed E2E ${slug} · open` });
  await expect(page.getByLabel('Share link')).toHaveValue(
    new RegExp(`/o/${slug}\\?utm_source=email$`),
  );
  await page.getByRole('button', { name: 'instagram' }).click();
  await expect(page.getByLabel('Share link')).toHaveValue(/utm_source=instagram$/);
  await expect(page.getByRole('img', { name: /QR code for/ })).toBeVisible();
  await expect(page.locator('pre code')).toContainText(`data-listing="${slug}" data-theme="light"`);

  await page.getByRole('button', { name: 'dark' }).click();
  await expect(page.locator('pre code')).toContainText('data-theme="dark"');
  const preview = page.frameLocator('iframe[title^="Button preview, dark"]');
  await expect(preview.getByText(/MOCK STORE/)).toBeVisible();
  await expect(preview.getByRole('link', { name: 'Make an offer' })).toBeVisible();

  const row = page.getByRole('row', { name: /^email/ });
  await expect(row).toContainText('1');
});
