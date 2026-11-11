import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-061 E2E on the FakePayPal stub: M10 brand mobile alert + clear approval at 375 px.
 *  1. The listing route renders M10 on a phone (mini KPIs, compact curve, "Review & clear") and
 *     W06 on a laptop.
 *  2. Race: a SIM bid is raised while the sheet is open → the slide gets 409 BOOK_CHANGED → the
 *     sheet shows the new gross with one-click "Confirm $X" → cleared; M10 stays and shows
 *     settlement progress.
 *  3. Race: two phones open the sheet; the first clears, the second's slide gets 409
 *     NOT_CLEARABLE (CLEARING), a lost success, and lands on the same progress.
 * Run like offer-page.spec.ts (see playwright.config.ts). Every test signs in as the one demo
 * OWNER, so they share its 60 calls/min REST budget (HF-006): run the file once per server start
 * (`--repeat-each` trips 429 RATE_LIMITED). `afterAll` waits the window out so the specs after
 * this one (rounds-console, rounds-feed: the same OWNER) start with a full budget.
 */

const DB = process.env.E2E_DATABASE_URL;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../scripts/offer-fixture.mjs', import.meta.url));
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true };

test.skip(!DB, 'E2E_DATABASE_URL is not set');

test.afterAll(async () => {
  test.setTimeout(90_000);
  await new Promise((r) => setTimeout(r, 61_000));
});

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

function devBids(slug: string, ...args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', '--conditions=source', 'apps/api/src/cli/dev-bids.ts', '--listing', slug, ...args],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB }, stdio: 'pipe', timeout: 60_000 },
  ).toString();
}

async function demoSignIn(page: Page): Promise<string> {
  await page.goto('/');
  return page.evaluate(async () => {
    const r = await fetch('/api/auth/demo/brand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ role: 'OWNER' }),
    });
    const body = (await r.json()) as { brandUser?: { brand: { id: string } } };
    if (!body.brandUser)
      throw new Error(`demo sign-in failed: ${r.status} ${JSON.stringify(body)}`);
    return body.brandUser.brand.id;
  });
}

/** A listing with `bids` eligible SIM holds and `quantity` units. */
async function listingWithBids(
  brandId: string,
  bids: number,
  quantity: number,
): Promise<{ id: string; slug: string }> {
  const slug = `e2e-m10-${randomUUID().slice(0, 8)}`;
  execFileSync('node', [FIXTURE, '--slug', slug, '--bids', '0', '--quantity', String(quantity)], {
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
    timeout: 60_000,
  });
  const [listing] = await sql<{ id: string }>(
    `UPDATE listings SET brand_id = $1 WHERE slug = $2 RETURNING id`,
    [brandId, slug],
  );
  devBids(slug, '--count', String(bids), '--interval', '0');
  // SIM amounts are random around the floor: a $1 floor makes every bid eligible, so the
  // quantities below are exact and any raise moves the gross.
  await sql(`UPDATE listings SET floor_cents = 100 WHERE id = $1`, [listing!.id]);
  return { id: listing!.id, slug };
}

/** Opens the sheet and waits for W07's numbers. */
async function openSheet(page: Page) {
  await page.getByTestId('m10-review-clear').click();
  const sheet = page.getByTestId('m10-clear-sheet');
  await expect(sheet.getByTestId('clear-money')).toBeVisible({ timeout: 10_000 });
  return sheet;
}

test('M10 on a phone, W06 on a laptop; BOOK_CHANGED → one-click confirm', async ({
  page,
  browser,
}) => {
  const brandId = await demoSignIn(page);
  const listing = await listingWithBids(brandId, 4, 10);

  // Laptop: the same route is W06.
  await page.goto(`/brand/listings/${listing.id}`);
  await expect(page.getByTestId('clear-button')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('m10')).toHaveCount(0);

  const ctx = await browser.newContext({
    ...PHONE,
    storageState: await page.context().storageState(),
  });
  const phone = await ctx.newPage();
  await phone.goto(`/brand/listings/${listing.id}`);
  const m10 = phone.getByTestId('m10');
  await expect(m10).toBeVisible({ timeout: 15_000 });
  await expect(m10.getByTestId('m10-alert')).toContainText(/^Window closes in .+ · .+ held$/);
  await expect(m10.locator('[data-kpi="held"]')).toBeVisible();
  await expect(m10.getByTestId('m10-curve')).toBeVisible();
  await expect(phone.getByTestId('m10-quantity')).toHaveText('4');
  await expect(phone.getByTestId('m10-review-clear')).toHaveText(/Review & clear 4/i);
  if (process.env.E2E_SCREENSHOT_DIR) {
    await phone.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/hf-061-m10.png` });
  }

  const sheet = await openSheet(phone);
  // Every bid wins, so a raise moves the gross under the open sheet.
  devBids(listing.slug, '--count', '0', '--raise', '1');

  // Drag the thumb to the end (pointer events, as a finger would).
  const thumb = sheet.getByRole('slider', { name: 'Slide to clear 4' });
  const box = (await thumb.boundingBox())!;
  const track = (await sheet.getByTestId('clear-slide').boundingBox())!;
  await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await phone.mouse.down();
  await phone.mouse.move(track.x + track.width - 4, box.y + box.height / 2, { steps: 8 });
  await phone.mouse.up();

  await expect(sheet.getByRole('alert')).toContainText('Book changed: new gross', {
    timeout: 10_000,
  });
  if (process.env.E2E_SCREENSHOT_DIR) {
    await phone.screenshot({
      path: `${process.env.E2E_SCREENSHOT_DIR}/hf-061-m10-book-changed.png`,
    });
  }
  const confirm = sheet.getByTestId('clear-confirm');
  await expect(confirm).toHaveText(/^Confirm \$/);
  await confirm.click();

  await expect(phone.getByTestId('m10-progress')).toBeVisible({ timeout: 15_000 });
  expect(new URL(phone.url()).pathname).toBe(`/brand/listings/${listing.id}`);
  const [row] = await sql<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
    listing.id,
  ]);
  expect(['CLEARING', 'SETTLED', 'PAID_OUT']).toContain(row!.status);
  if (process.env.E2E_SCREENSHOT_DIR) {
    await phone.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/hf-061-m10-progress.png` });
  }
  await ctx.close();
});

test('two phones race: the second slide is NOT_CLEARABLE and lands on progress', async ({
  page,
  browser,
}) => {
  const brandId = await demoSignIn(page);
  const listing = await listingWithBids(brandId, 3, 10);
  const state = await page.context().storageState();
  const [a, b] = await Promise.all([
    browser.newContext({ ...PHONE, storageState: state }),
    browser.newContext({ ...PHONE, storageState: state }),
  ]);
  const phoneA = await a.newPage();
  const phoneB = await b.newPage();
  for (const p of [phoneA, phoneB]) {
    await p.goto(`/brand/listings/${listing.id}`);
    await expect(p.getByTestId('m10-review-clear')).toBeEnabled({ timeout: 15_000 });
  }
  const sheetA = await openSheet(phoneA);
  const sheetB = await openSheet(phoneB);

  // Keyboard path on A: End slides the thumb to the end.
  await sheetA.getByRole('slider').focus();
  await phoneA.keyboard.press('End');
  await expect(phoneA.getByTestId('m10-progress')).toBeVisible({ timeout: 15_000 });

  // B still shows the old sheet; its Clear is refused (CLEARING) and treated as done.
  await sheetB.getByRole('slider').focus();
  await phoneB.keyboard.press('End');
  await expect(phoneB.getByTestId('m10-progress')).toBeVisible({ timeout: 15_000 });
  await expect(phoneB.getByTestId('m10-clear-sheet')).not.toBeVisible();

  // Cleared exactly once.
  const [cleared] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE listing_id = $1 AND action = 'LISTING_CLEARED'`,
    [listing.id],
  );
  expect(cleared!.n).toBe(1);
  await a.close();
  await b.close();
});

test('during live rounds M10 reads "Stop rounds & clear" and clears from the sheet', async ({
  page,
  browser,
}) => {
  const brandId = await demoSignIn(page);
  const listing = await listingWithBids(brandId, 6, 4);
  const started = await page.evaluate(async (id) => {
    const r = await fetch(`/api/listings/${id}/rounds/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ targetQuantity: 3 }),
    });
    return r.status;
  }, listing.id);
  expect(started).toBeLessThan(300);

  const ctx = await browser.newContext({
    ...PHONE,
    storageState: await page.context().storageState(),
  });
  const phone = await ctx.newPage();
  await phone.goto(`/brand/listings/${listing.id}`);
  const button = phone.getByTestId('m10-review-clear');
  await expect(button).toHaveText(/Stop rounds & clear 3/i, { timeout: 15_000 });

  // The sheet stops rounds (the book freezes), then shows W07's numbers.
  const sheet = await openSheet(phone);
  const [{ status }] = await sql<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [
    listing.id,
  ]);
  expect(status).toBe('ROUNDS');
  await sheet.getByRole('slider', { name: 'Slide to clear 3' }).focus();
  await phone.keyboard.press('End');
  await expect(phone.getByTestId('m10-progress')).toBeVisible({ timeout: 15_000 });
  await ctx.close();
});
