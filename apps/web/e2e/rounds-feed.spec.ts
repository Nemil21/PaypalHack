import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-037b E2E on the FakePayPal stub: the W06 raises feed.
 *  1. Live: start rounds, a SIM shopper raises (`dev:bids --raise`, the real `landHold` swap):
 *     within 2 s the feed shows "New $X hold placed · $Y hold released" with the SIM chip, the
 *     round summary counts the raise and its expected gross Δ, and the grid flashes the row.
 *     Stop → "Rounds ended in round 1: stopped."
 *  2. The HF-036a fixture replay with `--extend`: the "+10 min (late raise)" note by the timer and
 *     an extension row; with `--end --end-reason NO_RAISES` the end reason.
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

function replayFrames(listingId: string, ...args: string[]): string {
  return execFileSync(
    'npx',
    ['tsx', 'scripts/rounds-replay.ts', '--listing', listingId, '--delay', '0', ...args],
    { cwd: ROOT, stdio: 'pipe' },
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
    if (!body.brandUser) throw new Error(`demo sign-in failed: ${r.status}`);
    return body.brandUser.brand.id;
  });
}

async function listingWithBids(brandId: string, bids: number) {
  const slug = `e2e-feed-${randomUUID().slice(0, 8)}`;
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

const usd = (cents: number) =>
  `${cents < 0 ? '−' : '+'}$${Math.floor(Math.abs(cents) / 100).toLocaleString('en-US')}`;

test('live: a raise reaches the feed, summary and grid within 2 s; stop shows the reason', async ({
  page,
}) => {
  const brandId = await demoSignIn(page);
  const listing = await listingWithBids(brandId, 6);
  await page.goto(`/brand/listings/${listing.id}`);

  const panel = page.getByTestId('rounds-panel');
  await page.getByRole('button', { name: 'Start live rounds' }).click({ timeout: 15_000 });
  await page.getByTestId('rounds-target-input').fill('3');
  await page.getByRole('button', { name: 'Start rounds' }).click();
  await expect(panel.getByTestId('round-header')).toContainText('Round 1', { timeout: 5_000 });
  await expect(panel.getByTestId('round-summary-1')).toHaveText(
    /^Round 1: nudged \d+, raised 0, expected gross \+\$0$/,
  );
  await expect(panel.getByTestId('raises-feed-empty')).toBeVisible();

  const out = devBids(listing.slug, '--count', '0', '--raise', '1', '--interval', '0');
  const [, from, to] = /RAISED\s+(\$[\d,]+) → (\$[\d,]+)/.exec(out) ?? [];
  expect(from && to).toBeTruthy();

  const row = panel.getByTestId('feed-raise');
  await expect(row).toHaveCount(1, { timeout: 2_000 });
  await expect(row).toContainText(`New ${to} hold placed · ${from} hold released`);
  await expect(row).toContainText('SIM');
  await expect(row).toContainText(/Shopper #\d+/);
  await expect(page.getByTestId('raise-flash')).toHaveCount(1, { timeout: 2_000 });

  // The summary's gross Δ is the server's expected gross now minus at the round's start.
  const a = await page.evaluate(async (id) => {
    const r = await fetch(`/api/listings/${id}/rounds/activity`);
    return (await r.json()) as {
      expectedGrossCents: number;
      rounds: { grossAtStartCents: number }[];
    };
  }, listing.id);
  const delta = a.expectedGrossCents - a.rounds[0]!.grossAtStartCents;
  await expect(panel.getByTestId('round-summary-1')).toContainText(
    `raised 1, expected gross ${usd(delta)}`,
    { timeout: 2_000 },
  );

  if (process.env.E2E_SCREENSHOT_DIR) {
    await panel.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/hf-037b-raises-feed.png` });
  }

  await panel.getByRole('button', { name: 'Stop rounds' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop rounds' }).click();
  await expect(panel.getByTestId('rounds-end-reason')).toHaveText(
    'Rounds ended in round 1: stopped.',
    { timeout: 2_000 },
  );
  await expect(panel.getByTestId('feed-ended')).toContainText('stopped');
  // The final round keeps its expected gross Δ after the end.
  await expect(panel.getByTestId('round-summary-1')).toContainText(
    `raised 1, expected gross ${usd(delta)}`,
  );
});

test('replay: late raise extends the timer with a note; the end shows its reason', async ({
  page,
}) => {
  const brandId = await demoSignIn(page);
  const listing = await listingWithBids(brandId, 3);

  const extended = replayFrames(listing.id, '--round-ms', '300000', '--extend');
  await page.route(`**/api/listings/${listing.id}/events`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: extended }),
  );
  await page.goto(`/brand/listings/${listing.id}`);
  const panel = page.getByTestId('rounds-panel');
  await expect(panel.getByTestId('round-extended-note')).toHaveText('+10 min (late raise)', {
    timeout: 15_000,
  });
  // 5-minute round + 10 minutes.
  await expect(panel.getByTestId('round-ends-in')).toHaveText(/^ends in 1[0-4]:[0-5]\d$/);
  await expect(panel.getByTestId('feed-extended')).toContainText(
    'Round 1 extended +10 min (late raise)',
  );
  await expect(panel.getByTestId('feed-raise')).toHaveCount(3);
  await expect(panel.getByTestId('feed-raise').first()).toContainText(
    /New \$[\d,.]+ hold placed · \$[\d,.]+ hold released/,
  );
  await expect(panel.getByTestId('round-summary-1')).toContainText('raised 3');

  await page.unroute(`**/api/listings/${listing.id}/events`);
  const ended = replayFrames(
    listing.id,
    '--round-ms',
    '300000',
    '--end',
    '--end-reason',
    'NO_RAISES',
  );
  await page.route(`**/api/listings/${listing.id}/events`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ended }),
  );
  await page.reload();
  await expect(panel.getByTestId('rounds-end-reason')).toHaveText(
    'Rounds ended in round 1: no raises last round.',
    { timeout: 20_000 },
  );
});
