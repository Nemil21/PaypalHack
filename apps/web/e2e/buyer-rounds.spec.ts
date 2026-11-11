import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * HF-038a E2E on the FakePayPal stub: a held bid → the brand starts rounds and this shopper is
 * nudged (fixture SQL, as HF-036a's snapshot writes it) → the bid page's 5 s poll shows the nudge
 * → one tap raises to the suggested amount (new hold HELD, old one released) → after
 * `rounds_end_at` the raise is gone: "Rounds ended. Waiting for the brand to clear."
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

async function hold(page: Page, slug: string): Promise<string> {
  await page.goto(`/o/${slug}`);
  await page.getByRole('button', { name: 'Use sandbox test card' }).click();
  await expect(page).toHaveURL(/\/bids\/[0-9a-f-]{36}\?held=1$/);
  return /\/bids\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

/**
 * Rounds started (D6/D7) with this bid nudged below a $240 cutoff in round 1, and the buyer
 * agent's decision on it (HF-038b `NUDGE_HANDLED`), as the nudge consumer records it. Writing it
 * here keeps the server's nudge sweep from deciding on its own clock mid-test.
 */
async function startRoundsWithNudge(
  bidId: string,
  agent: { reason: string; targetCents: number } = { reason: 'NO_MANDATE', targetCents: 24_240 },
) {
  const [b] = await sql<{ listing_id: string; shopper_id: string }>(
    `SELECT listing_id, shopper_id FROM bids WHERE id = $1`,
    [bidId],
  );
  await sql(
    `UPDATE listings
        SET status = 'ROUNDS', current_round = 1, target_quantity = 1,
            rounds_started_at = now(), window_closes_at = least(window_closes_at, now()),
            rounds_end_at = now() + interval '50 minutes',
            clear_deadline_at = least(now() + interval '6 hours 50 minutes',
                                      window_opens_at + interval '60 hours')
      WHERE id = $1`,
    [b!.listing_id],
  );
  const [n] = await sql<{ id: string }>(
    `INSERT INTO nudges (listing_id, round, shopper_id, bid_id, cutoff_cents, target_cents,
                         your_bid_cents, units_left, text, sent_at)
     VALUES ($1, 1, $2, $3, 24000, 24240, 22900, 1,
             'You''re out at $229. The cutoff is $240. Raise to $242.40?', now())
     RETURNING id`,
    [b!.listing_id, b!.shopper_id, bidId],
  );
  await sql(
    `INSERT INTO audit_events (actor_type, actor_id, listing_id, entity, entity_id, action, data)
     VALUES ('BUYER_AGENT', $2, $1, 'bid', $3, 'NUDGE_HANDLED', $4::jsonb)`,
    [
      b!.listing_id,
      b!.shopper_id,
      bidId,
      JSON.stringify({
        nudgeId: n!.id,
        round: 1,
        outcome: 'ASKED',
        reason: agent.reason,
        cutoffCents: 24_000,
        targetCents: agent.targetCents,
        newBidId: null,
      }),
    ],
  );
  return b!.listing_id;
}

test('nudge appears on the next poll; one tap raises; frozen book hides the raise', async ({
  page,
}) => {
  const slug = fixtureListing();
  const oldId = await hold(page, slug);
  await page.goto(`/bids/${oldId}`);
  await expect(page.getByText('$229 held, not charged').first()).toBeVisible();

  const listingId = await startRoundsWithNudge(oldId);
  const nudge = page.getByText("You're out at $229. The cutoff is $240. Raise to $242.40?");
  await expect(nudge).toBeVisible({ timeout: 7_000 }); // 5 s poll

  // No mandate: the agent asks, so the M07 sheet opens once (HF-038b). Keep, then one tap.
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Keep $229' }).click();
  await expect(sheet).toHaveCount(0);

  await page.getByRole('button', { name: 'Raise to $242.40', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(oldId));
  const newId = /\/bids\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(
    page.getByText(/New \$242\.40 hold placed · \$229 hold releas/).first(),
  ).toBeVisible();

  const rows = await sql<{ id: string; status: string; void_reason: string | null }>(
    `SELECT id, status, void_reason FROM bids WHERE id = ANY($1::uuid[])`,
    [[oldId, newId]],
  );
  expect(rows.find((r) => r.id === newId)).toMatchObject({ status: 'HELD' });
  expect(rows.find((r) => r.id === oldId)).toMatchObject({ void_reason: 'REPLACED' });
  await expect(nudge).toHaveCount(0); // $242.40 beats the cutoff

  // Frozen book: rounds over, the raise is gone.
  await sql(`UPDATE listings SET rounds_end_at = now() WHERE id = $1`, [listingId]);
  await page.reload();
  await expect(page.getByText('Rounds ended. Waiting for the brand to clear.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Raise to/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Raise', exact: true })).toHaveCount(0);
});

test('HF-038b: the agent asks over its max → M07 opens with why; the shopper picks an amount', async ({
  page,
}) => {
  const slug = fixtureListing();
  const oldId = await hold(page, slug);
  await page.goto(`/bids/${oldId}`);
  await expect(page.getByText('$229 held, not charged').first()).toBeVisible();

  await startRoundsWithNudge(oldId, { reason: 'ABOVE_MANDATE_MAX', targetCents: 24_240 });
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: 7_000 }); // 5 s poll
  await expect(sheet.getByText('Bids around $240 are likely to clear.')).toBeVisible();
  await expect(
    sheet.getByText("$242.40 is above your agent's max, so it's asking you."),
  ).toBeVisible();
  await expect(sheet.getByText('Current bid')).toBeVisible();
  await expect(sheet.getByText('$229', { exact: true })).toBeVisible();

  // Stepper: + one step ($3 = 1% of $229, rounded up to whole dollars) → $245.40.
  await sheet.getByRole('button', { name: 'Raise more' }).click();
  await expect(sheet.getByText('$245.40', { exact: true })).toBeVisible();
  await sheet
    .getByRole('button', { name: 'Raise to $245.40 (new hold, old one released)' })
    .click();

  await expect(page).not.toHaveURL(new RegExp(oldId));
  const newId = /\/bids\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await expect(
    page.getByText(/New \$245\.40 hold placed · \$229 hold releas/).first(),
  ).toBeVisible();
  const [row] = await sql<{ status: string; amount_cents: number }>(
    `SELECT status, amount_cents FROM bids WHERE id = $1`,
    [newId],
  );
  expect(row).toMatchObject({ status: 'HELD', amount_cents: 24_540 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
