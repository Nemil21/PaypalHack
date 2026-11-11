// Placeholder until HF-007 scaffolds the React app. It imports the shared contracts the web app
// relies on so the browser build proves they bundle without Node polyfills.
import {
  feeCents,
  formatUsd,
  isBiddable,
  listingPhase,
  parseListingEvent,
  type ListingEvent,
} from '@holdfast/shared';

const now = Date.now();
const listing = { status: 'OPEN', windowClosesAt: now + 3_600_000 } as const;
const sample: ListingEvent = parseListingEvent({
  type: 'pricewatch.released',
  listingId: 'demo',
  at: new Date(now).toISOString(),
  count: 3,
  priceCents: 21_900,
  merchant: 'Example',
});

const root = document.getElementById('app');
if (root) {
  root.textContent = [
    `Holdfast web placeholder`,
    `biddable: ${String(isBiddable(listing, now))}`,
    `phase: ${listingPhase(listing, now).phase}`,
    `fee on ${formatUsd(5_424_000)}: ${formatUsd(feeCents(5_424_000))}`,
    `event: ${sample.type}`,
  ].join(' · ');
}
