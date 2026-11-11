# HF-008: SSE event bus for listings

- **Track / owner:** A money
- **Priority:** P0
- **Estimate:** 1
- **Depends on:** HF-006
- **Spec refs:** api.md §`GET /listings/:id/events`; features/19-live-rounds.md §Data / API (SSE events); README.md §Tech stack (Realtime)

## Goal
Push book and settlement changes to the console within 2 s, across multiple Render instances.

## Scope
- `publish(listingId, event, payload)` backed by Postgres `LISTEN/NOTIFY` (stateless instances, 16).
- `GET /api/listings/:id/events` (brand-only, tenant-checked) streaming `bid.held`, `bid.voided`, `bid.raised`, `settlement.updated`, `listing.status`, `round.started`, `round.nudged`.
- Heartbeat every 15 s; reconnect-safe (clients re-fetch the book on reconnect).

## Out of scope
- Agent chat SSE (HF-039 has its own stream).

## Acceptance criteria
- [ ] Event published on instance 1 reaches a client connected to instance 2.
- [ ] Another brand's user gets 404 on the stream.
- [ ] Payloads contain no shopper PII (labels only).

## Test plan
- Integration: two API processes + one subscriber.

## Notes & risks
- Publish after COMMIT, never inside a transaction that may roll back.
