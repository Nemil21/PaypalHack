import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-025 E2E on the FakePayPal stub: the W06 bids grid with live SIM bids from `dev:bids`.
 * New bids appear with a flash, a raise updates its row in place ("$219 → $241", same grid row
 * id), a released bid drops out, every SIM row carries the chip, no AG Grid watermark.
 * Run like offer-page.spec.ts (see playwright.config.ts). Set E2E_SCREENSHOT_DIR to keep the
 * visual snapshot.
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

/** Grid row ids (`getRowId`) of the data rows, in DOM order. */
async function rowIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="bids-grid"] .ag-row[row-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('row-id')!));
}

test('bids grid: live insert with flash, raise in place, release removes, SIM chips', async ({
  page,
}) => {
  const slug = `e2e-grid-${randomUUID().slice(0, 8)}`;
  execFileSync('node', [FIXTURE, '--slug', slug, '--bids', '0', '--quantity', '4'], {
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
  });

  // Demo brand sign-in (same origin, so the CSRF Origin check passes), then hand it the listing.
  await page.goto('/');
  const brandId = await page.evaluate(async () => {
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
  const [listing] = await sql<{ id: string }>(
    `UPDATE listings SET brand_id = $1 WHERE slug = $2 RETURNING id`,
    [brandId, slug],
  );

  devBids(slug, '--count', '6', '--interval', '0');
  await page.goto(`/brand/listings/${listing!.id}`);

  const grid = page.getByTestId('bids-grid');
  const rows = grid.locator('.ag-row[row-id]');
  await expect(rows).toHaveCount(6, { timeout: 15_000 });

  // Every row is a SIM bidder here, and every one shows the chip.
  await expect(grid.locator('.ag-row').getByTitle('Simulated bidder (demo seed)')).toHaveCount(6);
  await expect(grid.getByText(/^Shopper #\d+$/)).toHaveCount(6);
  // "Would win?" follows the slider (quantity 4): 4 winners among the ranked bids at most.
  expect(await grid.getByText('Wins', { exact: true }).count()).toBeLessThanOrEqual(4);

  // A new bid lands: one more row within 2 s, flashed.
  const before = await rowIds(page);
  devBids(slug, '--count', '1', '--interval', '0');
  const t0 = Date.now();
  await expect(rows).toHaveCount(7, { timeout: 2_000 });
  expect(Date.now() - t0).toBeLessThan(2_000);
  const added = (await rowIds(page)).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  await expect(
    grid
      .locator(
        `[row-id="${added[0]}"] .ag-cell-data-changed, [row-id="${added[0]}"] .ag-cell-data-changed-animation`,
      )
      .first(),
  ).toBeAttached({ timeout: 2_000 });

  // A raise: same row ids, one row shows old → new.
  const beforeRaise = (await rowIds(page)).sort();
  const out = devBids(slug, '--count', '0', '--raise', '1', '--interval', '0');
  const [, from, to] = /RAISED\s+(\$[\d,]+) → (\$[\d,]+)/.exec(out) ?? [];
  expect(from && to).toBeTruthy();
  const flash = grid.getByTestId('raise-flash');
  await expect(flash).toHaveCount(1, { timeout: 2_000 });
  await expect(flash).toHaveAttribute('title', `${from} → ${to}`);
  expect((await rowIds(page)).sort()).toEqual(beforeRaise);
  await expect(rows).toHaveCount(7);

  if (process.env.E2E_SCREENSHOT_DIR) {
    await page
      .getByRole('region', { name: 'Bids' })
      .screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/hf-025-bids-grid.png` });
  }

  // The flash clears after a few seconds.
  await expect(flash).toHaveCount(0, { timeout: 8_000 });

  // A released (voided) bid is removed.
  devBids(slug, '--count', '0', '--release', '1', '--interval', '0');
  await expect(rows).toHaveCount(6, { timeout: 2_000 });

  // Licensed or Community: never a watermark.
  await expect(page.locator('.ag-watermark:visible')).toHaveCount(0);
});
