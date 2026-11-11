# HF-008: SSE event bus for listings (LISTEN side + streams)

- **Track:** B brand UI (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** HF-006
- **Spec refs:** api.md §`GET /listings/:id/events`; features/19-live-rounds.md §Data / API (SSE events); README.md §Tech stack (Realtime); review SUMMARY M29

## Goal
Push book, rounds and settlement changes to the console (and shoppers during rounds) within 2 s, across instances.

## Scope
- Publishers call HF-003a's `emit(tx, …)` (`pg_notify` inside the business transaction: delivered on COMMIT, dropped on ROLLBACK). This ticket owns the listener and streams.
- One `LISTEN listing_events` connection per instance with in-memory fan-out (not one connection per SSE client).
- Small payloads `{listingId, type, ids}` (NOTIFY's 8,000-byte cap); clients re-fetch details.
- `GET /api/listings/:id/events` (brand-only, tenant-checked) streaming the `ListingEvent` union from HF-001: `bid.held`, `bid.voided`, `bid.raised`, `settlement.updated`, `listing.status`, `round.started`, `round.nudged`, `round.extended`, `round.ended`, `payout.updated`, `pricewatch.released`.
- Shopper-side stream `GET /api/bids/:id/events` (own bid only) on the same bus, for M07 `belowCutoff` (HF-038a also polls every 5 s as fallback, D18).
- Heartbeat every 15 s; reconnect-safe (clients re-fetch on reconnect).

## Out of scope
- Agent chat streaming (HF-039 has its own stream).

## Acceptance criteria
- [ ] An event emitted in a committed transaction reaches a subscribed client within 2 s; a rolled-back one never does.
- [ ] Cross-instance: an event emitted on instance 1 reaches a client connected to instance 2.
- [ ] Another brand's user gets 404 on the stream; another shopper's bid stream → 404.
- [ ] Payloads contain no shopper PII (labels/ids only).
- [ ] 100 SSE clients use one LISTEN connection.

## Test plan
- Integration: two API processes + one subscriber (cross-instance); rollback test.

## Notes & risks
- Production runs one web instance; the cross-instance test still runs (kept in scope) so scaling later is safe.
- Render proxies may drop idle streams; the 15 s heartbeat covers it (HF-048b checks it on Render).
