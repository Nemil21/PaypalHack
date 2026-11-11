import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-037a E2E on the FakePayPal stub: the W06 live rounds controls.
 *  1. OWNER: start (target prefilled from the slider, D6/D7 confirm copy), round header,
 *     inline target edit, "Next round", "Stop" → the "Rounds ended. Press Clear by …" banner.
 *  2. VIEWER: sees the round state, no controls; the API answers 403.
 *  3. The HF-036a fixture replay (`npm run dev:rounds-replay`) alone drives the round header,
 *     the "ends in mm:ss" timer and the ended banner, without a reload.
 * Run like offer-page.spec.ts (see playwright.config.ts).
 */

const DB = process.env.E2E_DATABASE_URL;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
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

function devBids(slug: string, ...args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', '--conditions=source', 'apps/api/src/cli/dev-bids.ts', '--listing', slug, ...args],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB }, stdio: 'pipe' },
  ).toString();
}

/** The replay script's SSE output for one listing (no delay: the browser gets it in one body). */
function replayFrames(listingId: string, ...args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', 'scripts/rounds-replay.ts', '--listing', listingId, '--delay', '0', ...args],
    { cwd: ROOT, stdio: 'pipe' },
  ).toString();
}

async function demoSignIn(page: Page, role: 'OWNER' | 'VIEWER'): Promise<string> {
  await page.goto('/');
  return page.evaluate(async (role) => {
    const r = await fetch('/api/auth/demo/brand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ role }),
    });
    const body = (await r.json()) as { brandUser?: { brand: { id: string } } };
    if (!body.brandUser)
      throw new Error(`demo sign-in failed: ${r.status} ${JSON.stringify(body)}`);
    return body.brandUser.brand.id;
  }, role);
}

/** A listing with `bids` SIM holds, owned by the demo brand. */
async function listingWithBids(
  brandId: string,
  bids: number,
): Promise<{ id: string; slug: string }> {
  const slug = `e2e-rounds-${randomUUID().slice(0, 8)}`;
  execFileSync('node', [FIXTURE, '--slug', slug, '--bids', '0', '--quantity', '4'], {
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
  });
  const [listing] = await sql<{ id: string }>(
    `UPDATE listings SET brand_id = $1 WHERE slug = $2 RETURNING id`,
    [brandId, slug],
  );
  devBids(slug, '--count', String(bids), '--interval', '0');
  return { id: listing!.id, slug };
}

test('OWNER runs rounds; VIEWER watches without controls', async ({ page, browser }) => {
  const brandId = await demoSignIn(page, 'OWNER');
  const listing = await listingWithBids(brandId, 6);
  await page.goto(`/brand/listings/${listing.id}`);

  const panel = page.getByTestId('rounds-panel');
  // Target prefilled from the slider (listing quantity 4, 6 bids).
  await expect(panel.getByTestId('rounds-target-input')).toHaveValue('4', { timeout: 15_000 });
  await panel.getByTestId('rounds-target-input').fill('3');
  await panel.getByRole('button', { name: 'Start live rounds' }).click();
  await expect(page.getByTestId('rounds-start-copy')).toHaveText(
    /^Starting rounds closes bidding to new bids\. Rounds end by .+\. Clear by .+\.$/,
  );
  await page.getByRole('button', { name: 'Start rounds' }).click();

  const header = panel.getByTestId('round-header');
  await expect(header).toContainText('Round 1', { timeout: 5_000 });
  await expect(header.getByTestId('rounds-end')).toContainText('Rounds end');
  await expect(panel.getByTestId('rounds-target')).toHaveText('3');
  await expect(page.getByTestId('clear-button')).toContainText('Stop rounds & clear');
  const [row] = await sql<{ status: string; target_quantity: number }>(
    `SELECT status, target_quantity FROM listings WHERE id = $1`,
    [listing.id],
  );
  expect(row).toEqual({ status: 'ROUNDS', target_quantity: 3 });

  // Inline target edit → PATCH.
  await panel.getByRole('button', { name: 'Edit' }).click();
  await panel.getByTestId('rounds-target-edit').fill('4');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByTestId('rounds-target')).toHaveText('4');

  // Next round (4 winners of 6: two bidders stay below the cutoff, so rounds continue).
  await panel.getByRole('button', { name: 'Next round' }).click();
  await expect(header).toContainText('Round 2');
  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.E2E_SCREENSHOT_DIR}/hf-037a-rounds-console.png`,
      fullPage: true,
    });
  }

  // VIEWER of the same brand: the state, no controls; the API refuses.
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  expect(await demoSignIn(viewer, 'VIEWER')).toBe(brandId);
  await viewer.goto(`/brand/listings/${listing.id}`);
  const vPanel = viewer.getByTestId('rounds-panel');
  await expect(vPanel.getByTestId('round-header')).toContainText('Round 2', { timeout: 15_000 });
  await expect(vPanel.getByRole('button')).toHaveCount(0);
  const status = await viewer.evaluate(async (id) => {
    const r = await fetch(`/api/listings/${id}/rounds/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: '{}',
    });
    return r.status;
  }, listing.id);
  expect(status).toBe(403);

  // Stop → the ended banner, on both consoles, without a reload (SSE).
  await panel.getByRole('button', { name: 'Stop rounds' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop rounds' }).click();
  await expect(page.getByTestId('rounds-ended-banner')).toHaveText(
    /^Rounds ended\. Press Clear by .+\.$/,
  );
  await expect(panel.getByRole('button', { name: 'Next round' })).toHaveCount(0);
  await expect(viewer.getByTestId('rounds-ended-banner')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('clear-button')).not.toContainText('Stop rounds');
  await viewerCtx.close();
});

test('the fixture replay drives the round header, timer and banner', async ({ page }) => {
  const brandId = await demoSignIn(page, 'OWNER');
  const listing = await listingWithBids(brandId, 3);

  // Round 1 with a 5-minute timer, no end.
  const active = replayFrames(listing.id, '--round-ms', '300000');
  await page.route(`**/api/listings/${listing.id}/events`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: active }),
  );
  await page.goto(`/brand/listings/${listing.id}`);
  const header = page.getByTestId('round-header');
  await expect(header).toContainText('Round 1', { timeout: 15_000 });
  await expect(header.getByTestId('round-ends-in')).toHaveText(/^ends in 0[0-4]:[0-5]\d$/);
  await expect(page.getByTestId('rounds-target')).toHaveText('6');
  const first = await header.getByTestId('round-ends-in').textContent();
  await expect(header.getByTestId('round-ends-in')).not.toHaveText(first!, { timeout: 3_000 });

  // The same replay ending with `round.ended`.
  await page.unroute(`**/api/listings/${listing.id}/events`);
  const ended = replayFrames(listing.id, '--round-ms', '300000', '--end');
  await page.route(`**/api/listings/${listing.id}/events`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ended }),
  );
  await page.reload();
  await expect(page.getByTestId('rounds-ended-banner')).toHaveText(
    /^Rounds ended\. Press Clear by .+\.$/,
    { timeout: 20_000 },
  );
});
