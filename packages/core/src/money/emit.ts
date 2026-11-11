import { listingEventSchema, type ListingEvent, type ListingEventNotice } from '@holdfast/shared';
import type { Queryable } from '../db.js';

/** The `LISTEN` channel HF-008 subscribes to. */
export const LISTING_EVENTS_CHANNEL = 'listing_events';

/**
 * What goes over `pg_notify`: `{listingId, type, ids}` (`listingEventNoticeSchema` in
 * `@holdfast/shared`). Small, ids only (NOTIFY caps payloads at 8,000 bytes); SSE clients re-fetch
 * details. Never PII.
 */
export type { ListingEventNotice };

/** Pull the entity ids out of an event: bid, replaced bid, settlement, payout. */
export function noticeFor(event: ListingEvent): ListingEventNotice {
  const ids: Record<string, string> = {};
  if ('bidId' in event) ids.bidId = event.bidId;
  if ('replacesBidId' in event) ids.replacesBidId = event.replacesBidId;
  if (event.type === 'settlement.updated') {
    ids.settlementId = event.row.settlementId;
    ids.bidId = event.row.bidId;
  }
  if (event.type === 'payout.updated') ids.payoutId = event.payout.payoutId;
  return { listingId: event.listingId, type: event.type, ids };
}

/**
 * Publish a listing event with `pg_notify('listing_events', {listingId, type, ids})`.
 *
 * Call it with the **business transaction** (`tx`), never the pool: Postgres delivers a NOTIFY
 * only when that transaction commits and drops it on ROLLBACK, so listeners never see an event
 * for a change that did not happen. HF-008 owns the LISTEN side and the SSE streams.
 */
export async function emit(tx: Queryable, listingId: string, event: ListingEvent): Promise<void> {
  const parsed = listingEventSchema.parse(event);
  if (parsed.listingId !== listingId) {
    throw new Error(`emit: event listingId ${parsed.listingId} does not match ${listingId}`);
  }
  await tx.query(`SELECT pg_notify($1, $2)`, [
    LISTING_EVENTS_CHANNEL,
    JSON.stringify(noticeFor(parsed)),
  ]);
}
