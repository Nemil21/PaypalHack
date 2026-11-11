# HF-042b: Price watcher: live Channel3 webhook, outage banner, nightly poll

- **Track:** D integrations & demo (label for grouping only; builders are Agent Orchestrator workers)
- **Priority:** P0
- **Wave:** 7
- **Estimate:** 2
- **Depends on:** HF-042a, HF-048a; HF-031, HF-032, HF-034 (sequencing: after the money spine)
- **Spec refs:** features/06-price-watcher.md §Logic 1–2, 8, §Edge cases; api.md §`POST /webhooks/channel3`; spike S5

## Goal
Real Channel3 price events reach the deployed app and flow through HF-042a's path; the console warns when Channel3 is down, and a nightly poll backs up missed events. The replay path (HF-042a) is the fallback that ships first; this ticket is the full feature.

## Scope
- `POST /api/webhooks/channel3` with the real Channel3 payload shape (api.md): HMAC verify against `CHANNEL3_WEBHOOK_SECRET` in constant time; `webhook_events` insert/dedupe; 2xx within 15 s; processing via HF-042a's `processPriceEvent` (async, `processed_at` recovery loop). Exempt from CSRF/Idempotency-Key (HF-006).
- Spike S5 on Render (HF-048a URL): register the webhook, trigger or wait for an event, record the result in the ticket and README.
- Subscriptions: per product and variant (`products.channel3_subscription_id`), created at publish (HF-012a); this ticket verifies they deliver.
- Channel3-outage banner: when Channel3 calls fail repeatedly or no event/heartbeat is seen for the configured window, set a flag on affected listings; console and offer page show "Public price check paused".
- Nightly poll (cron via HF-034/HF-048b): for each product with live listings, fetch the detail endpoint and feed synthetic events (`data.source='poll'`) through `processPriceEvent`.

## Out of scope
- Replay path and the void logic (HF-042a).

## Acceptance criteria
- [ ] A bad or missing signature → 401, nothing stored (moved here from old HF-047).
- [ ] A real or provider-sent test event on Render is verified, deduped and processed; a duplicate delivery is a no-op.
- [ ] The outage banner appears when Channel3 is unreachable and clears when it recovers.
- [ ] The nightly poll detects a price change that no webhook delivered and processes it once.

## Test plan
- Unit: HMAC verify (good, bad, replayed body).
- Integration: signed fixture webhook → voids on the stub; poll with a recorded detail fixture.
- Manual: S5 on the deployed URL.

## Build notes (HF-042b PR)
- Channel3 signs with Svix / Standard Webhooks (`svix-id`, `svix-timestamp`, `svix-signature: v1,<base64>`, HMAC-SHA256 of `id.timestamp.body` with the base64 `whsec_` secret, 5-minute window), not a raw-body digest. Verified against the published reference vector.
- Outage state: migration `0003_price_watch_outage.sql` adds `listings.price_watch_paused_at` and a one-row `channel3_health`. Channel3 has no heartbeat, so ours is the `channel3-probe` cron (5 min); down = 3 failures in a row or 30 min without a successful call or delivery.
- Nightly poll: `price-poll` cron (hourly check, ≥ 23 h between polls). Feeds an event when the best allowlisted price differs from the stored one **or** a HELD bid would be released at it, because the offer page's 10-minute anchor refresh rewrites the stored price without voiding.
- S5 on Render: **not run** (manual; steps in docs/deploy/render.md §S5). Result to be recorded there and in the README.

## Notes & risks
- Resolved (user override): live webhook, outage banner and nightly poll stay in scope (not P1/README); sequenced after the money spine.
- If S5 fails at recording time, the demo uses the labelled replay (HF-042a) and the README says so.
