# Deploying Holdfast on Render (HF-048a)

Everything Render needs is in [`render.yaml`](../../render.yaml) (a Blueprint). This page is the runbook: what it creates, the one-time manual steps, and how to check a deploy. Crons, `demo:refresh`, the judge book and the full smoke are HF-048b ([below](#hf-048b-crons-demorefresh-judge-book-smoke)).

## What the Blueprint creates

| Resource | Name | Plan | Notes |
|---|---|---|---|
| Web service | `holdfast` | Starter (paid), **1 instance** | Fastify serves the API (`/api/*`), `/mcp`, `/healthz` and the built SPA from one origin (M31). In-process jobs and rate limits assume one instance. |
| Workflow | `holdfast-workflows` | per task (set in code) | Render Workflows: the `hello` task (HF-048a) and the settlement tasks `settleListing` / `settleBid` (HF-030b). |
| Postgres 16 | `holdfast-db` | `basic-256mb` (paid), 1 GB disk | Free Postgres expires ~30 days after creation, before judging ends Dec 21. Private network only (`ipAllowList: []`). |
| Cron job | `holdfast-demo-refresh` | Starter, `0 8 * * *` (08:00 UTC) | HF-048b: `npm run demo:refresh` daily; resets the market and reseeds the judge book. |
| Env group | `holdfast-config` | | Non-secret flags only: `NODE_VERSION=22`, `NODE_ENV=production`, sandbox PayPal base/mode, `SETTLEMENT_RUNNER=inprocess`, `DEMO_MODE=true`, `RENDER_WORKFLOW_SLUG`. |

Deploy pipeline for the web service:

1. **Build:** `npm ci --include=dev && npm run build`. `NODE_ENV=production` is also set at build time, so devDependencies (tsc, vite) need the explicit `--include=dev`.
2. **Pre-deploy:** `npm run migrate`. Migrations only: idempotent, checksummed, one transaction per file, under an advisory lock (HF-002). **Nothing seeds on deploy.** Seeding is manual or the HF-048b `demo:refresh` cron.
3. **Start:** `npm start` (`node apps/api/dist/main.js`). Render routes traffic once `GET /healthz` returns 200.

`GET /healthz` is public and does a single `SELECT 1` with a 2 s timeout: `200 {"status":"ok","db":"ok"}` or `503 {"status":"error","db":"unreachable"}`. It returns no config, versions or error text. `GET /api/healthz` (HF-001) still reports the PayPal mode and runner flags. The admin health page is HF-058.

## Cost (check against the Render pricing page when claiming credits)

Nov 11 to Dec 21 is about 1.35 months. Starter web (~$7/month) plus `basic-256mb` Postgres (~$6/month) plus 1 GB storage (~$0.30/month) comes to about **$18 for the whole period**. Workflow task runs are billed per second of compute, and the hello task runs for a second or two. HF-030b's settlement runs are the only material workflow cost. The $50 hackathon credit covers this. Confirm the projected spend on the Billing page after the first deploy.

## One-time manual steps

Do these in order. Secret values come from your local `.env`: paste them straight into the Render dashboard, never into chat, tickets or commits.

1. **Claim the Render credits**: <https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon>, then apply them to the workspace (<https://render.com/docs/credits>). Check that Billing shows the credit.
2. **Create a Render API key**: Account Settings → API Keys → Create. This is `RENDER_API_KEY`. The web service uses it to trigger workflow tasks.
3. **Apply the Blueprint**: Dashboard → **New → Blueprint** → connect `Nemil21/PaypalHack`, branch `main`. Render reads `render.yaml` and lists the resources above.
4. **Fill the prompted secrets** (`sync: false`). Render asks for each one once, per service:
   - `holdfast` (web): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BRAND_EMAIL`, `ADMIN_EMAILS`, `CHANNEL3_API_KEY`, `CHANNEL3_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AG_GRID_LICENSE_KEY`, `RENDER_API_KEY` (step 2). `APP_BASE_URL` is `https://holdfast.onrender.com`, or whatever host Render assigns if that name is taken (fix it after step 5). Leave `PAYPAL_WEBHOOK_ID` empty for now (step 8).
   - `holdfast-workflows`: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (same values; HF-030b's settlement tasks need them).
   - Only `DATABASE_URL` (from the database), `SESSION_SECRET` (generated) and the PayPal keys are required at boot. Feature keys can be filled later and fail only when their feature is used.
5. **First deploy**: watch the `holdfast` events. The pre-deploy log should show `[migrate] applied 0001_init.sql`, and the deploy goes live once `/healthz` passes. Note the service URL. If it differs from `APP_BASE_URL`, edit the variable and redeploy.
6. **Workflow service**: open `holdfast-workflows` and check that its deploy registered the `hello` task. The task page shows the slug (`<workflow-slug>/hello`). If the slug isn't `holdfast-workflows`, set `RENDER_WORKFLOW_SLUG` in the `holdfast-config` group to the part before `/`.
   - If the Blueprint didn't create the workflow (Workflows in Blueprints is new), create it by hand: **New → Workflow**, language Node, region **Oregon** (same as the DB, for the private network), build `npm ci --include=dev && npm run build -w @holdfast/shared -w @holdfast/core -w @holdfast/workflows`, start `node apps/workflows/dist/main.js`. Then link the `holdfast-config` group and add `DATABASE_URL` = the database's **internal** URL plus the two PayPal keys.
7. **Trigger the hello-world from the web service**: `holdfast` → Shell → `npm run workflows:hello`. Expect `"status": "succeeded"` and a result with `db.firstMigration: "0001_init.sql"` and `env.DATABASE_URL: true`. The run also appears under `holdfast-workflows` → Runs (the run view used in the video). The result reports key **presence** only, never values.
8. **Register the Render URLs** (replace `<host>` with the service host):
   | Where | Setting | Value |
   |---|---|---|
   | PayPal Developer Dashboard → sandbox app → Webhooks | Add webhook | `https://<host>/api/webhooks/paypal`. Events: the authorization, capture and payouts events HF-033 handles (`PAYMENT.AUTHORIZATION.*`, `PAYMENT.CAPTURE.*`, `PAYMENT.PAYOUTSBATCH.*`, `PAYMENT.PAYOUTS-ITEM.*`, `CHECKOUT.ORDER.APPROVED`). Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` on `holdfast`. |
   | PayPal Developer Dashboard → sandbox app → Log in with PayPal | Return URL (HF-010) | `https://<host>/api/auth/paypal/callback`. Enable the email scope. |
   | Per order, no dashboard step | Wallet approval return / cancel (HF-014b) | Built from `APP_BASE_URL`: `https://<host>/api/bids/return?…`. Only `APP_BASE_URL` has to be right. |
   | Channel3 dashboard → Webhooks (Svix portal) → Add Endpoint (HF-042b) | Webhook URL | `https://<host>/api/webhooks/channel3`, event types `offer.price.changed` (the others are recorded and ignored). Copy the endpoint's signing secret (`whsec_…`) into `CHANNEL3_WEBHOOK_SECRET` on `holdfast`. See S5 below. |
   | Claude Desktop / MCP clients (HF-043/044a) | Server URL | `https://<host>/mcp` |

## S5: Channel3 price webhook reaches Render (HF-042b)

Manual, after step 8. Never paste the signing secret into a terminal log or a ticket.

1. **Our side first:** from a laptop with the secret in `.env` (or the env), `node scripts/channel3-webhook-smoke.mjs https://<host>`. Expect `delivery: HTTP 200` then `duplicate: HTTP 200`, and `--unsigned` → `401`. In the Render logs: `channel3 webhook processed` with `outcome: UNWATCHED` (the fixture product has no listing) for one event id only.
2. **Channel3's side:** in the Channel3 webhook portal open the endpoint → Testing → send an `offer.price.changed` example. The portal's message log must show a `200` attempt; Render logs `channel3 webhook processed`. If it shows `401`, the secret in `CHANNEL3_WEBHOOK_SECRET` is not this endpoint's.
3. **A real delivery (optional, slow):** publish a listing on a real Channel3 product (HF-012a subscribes it) and wait for Channel3's daily re-scrape to fire a price change. Check `SELECT id, received_at, processed_at FROM webhook_events WHERE provider = 'CHANNEL3' AND NOT (payload ? 'replayed') ORDER BY received_at DESC LIMIT 5;`.
4. **Record the result** here and in the README (§PayPal APIs used spike list): date, which of steps 1–3 passed, the event id. Then replace `fixtures/channel3/webhooks/offer.price.changed.json` with the live body (no headers).

Result: _not run yet_. If S5 fails at recording time, the demo uses the labelled replay (`npm run demo:price-drop`, HF-042a) and the README says so.

Outage banner check: the `channel3-probe` cron runs every 5 minutes. With a wrong `CHANNEL3_API_KEY` (or Channel3 down) three probes in a row fail and every live listing shows "Public price check paused" (audit `PRICE_WATCH_PAUSED`); the first good probe clears it (`PRICE_WATCH_RESUMED`). The nightly poll (`price-poll`, at most once per 23 h, audited as `CRON_RUN` when it did something) backs up missed webhooks.

## Settlement on Workflows (HF-030b)

`SETTLEMENT_RUNNER=workflows` on `holdfast` makes every settlement kick (Clear, the 1-minute outbox kick, admin retry) start the `settleListing` task on `holdfast-workflows` instead of settling in the web process. That task runs the same coordinator as the in-process runner, and each settlement row is a child `settleBid` run, so the run view shows the fan-out. Render-level retries are 0 on both tasks; `settleBid` owns PayPal retries (D11).

- The first run per listing starts with `idempotencyKey = listingId`; its id is stored on `settlement_runs.workflow_run_id` and returned as `workflowRunId` by `GET /api/listings/:id/settlement`. A kick while that run is live does nothing. A run that ended without finishing the listing (killed, failed, or handed back after 5 minutes) is followed by run n with key `<listingId>:<n>` on the next kick; one Render still calls running after its lease expired is cancelled first.
- The workflow service needs the same config as the web service (`loadConfig`): the Blueprint adds `SESSION_SECRET` (generated) and a prompted `ALLOW_MOCK_DECLINE` (set `true` for the decline run). It must use the sandbox, not `PAYPAL_MODE=stub`.

Smoke (from the `holdfast` Shell, after the steps above):

1. Set `ALLOW_MOCK_DECLINE=true` on both services and `SETTLEMENT_RUNNER=workflows` on `holdfast`; redeploy. `/api/healthz` shows `settlementRunner: "workflows"`.
2. Place 10 sandbox holds on a listing (offer page with the labelled test card, or HF-045's seed once merged; `npm run dev:bids` makes stub holds and won't capture on the sandbox) and Clear it from the console. Then `npm run workflows:settle -- <listingId>`: it kicks (or finds) the run, waits, and prints `workflowRunId`, counts and each capture's PayPal id. Expect SETTLED, one capture per winner, one payout.
3. 50 bids with one decline (`demo_decline_rank` set before Clear): same command; expect 1 promotion at the promoted bidder's own bid and the same counts as the in-process run.
4. Kill and resume: start a 50-bid run, cancel it in `holdfast-workflows` → Runs mid-way; within about a minute the outbox kick starts run 2 (`<listingId>:2`). Each charged authorization has exactly one capture id; one payout.
5. If any step misbehaves, set `SETTLEMENT_RUNNER=inprocess` again (the default) and say so in the README.

## HF-048b: crons, `demo:refresh`, judge book, smoke

### Background jobs: in-process, not Render crons

The sweeper (every 5 min), settlement kick and payout poll (every minute), listing expiry, webhook / price-event replays, Channel3 probe, nightly price poll, intent move rule and notify run **in the web process** (`startCrons`, HF-034). Each job runs under its own Postgres advisory lock, so a second instance would never double-call PayPal. The HF-036b round tick also runs in-process (every 5 s, locked per listing). Render cron is used only for `demo:refresh` (tickets/INDEX.md, background jobs).

The job locks have their own small pool (one connection per job). With the locks in the app pool, 11 jobs firing at boot on a 10-connection pool deadlocked the API: `/healthz` returned 503 and SSE stalled. Fixed in `apps/api/src/main.ts`.

### Daily `demo:refresh` (08:00 UTC, through Dec 21)

`npm run demo:refresh` (`apps/api/src/cli/demo-refresh.ts`) keeps the hosted demo alive without anyone editing it after the deadline:

1. One refresh at a time (advisory lock). A second run while one is going prints `skipped` and exits 0.
2. `demo:reset` (HF-046): close live listings → sweep → `reconcile:holds` → GET **every** authorization id in the database and refuse if any is still `CREATED` → truncate (keeps brands, products, the `is_demo_foreground` shopper, their vault, mandates and MCP tokens).
3. Reseed the **judge book** (`JUDGE_BOOK` in `apps/api/src/demo/bid-table.ts`): Aurel Audio (demo), 60 real sandbox holds over the five test cards (44 at $219–$249, 8 at $189–$217, 4 vaulted round agents with mandates, 4 on the A5). The A7 listing has 50 units, so a judge's Clear has winners **and** voided losers; `simulate(44)` reads cutoff $219. The window stays open **30 h**, so one missed run still leaves the market open, and holds are never older than ~2 days (well under the 66 h aged-hold pass).
4. Check: the new A7 listing is `OPEN` with its window still open, and **no bid is left on any listing from an earlier book**. The output states how many authorizations were GET-checked.

If a judge's Clear is still settling at 08:00, or another reset or sweeper holds a lock, the refresh waits 2 min and retries (6 attempts). A failed verify (a hold still `CREATED`, or GETs failing) stops at once, deletes nothing, and exits 1. Render shows the failed run, and the previous book stays up. Rerun it by hand once PayPal answers.

The cron's `DEMO_ADMIN_DATABASE_URL` is the database connection string: the Blueprint's database user ran the migrations, so it owns the schema and can truncate the append-only audit log.

### Judge access

- `DEMO_MODE=true` (env group) enables **Sign in as demo shopper / demo brand** (HF-006), one click and no account needed. The demo brand is Aurel Audio's OWNER. The demo shopper is the `is_demo_foreground` shopper the refresh keeps.
- For the README / Devpost testing instructions (HF-049, HF-050a): the labelled **Use sandbox test card** button on the offer page (`/o/aurel-a7`), and a sandbox **personal** buyer account for Pay with PayPal. Its email and password go in the Devpost testing-instructions field only, never in the repo.

### SSE behind Render's proxy

`GET /api/listings/:id/events` (brand console) and `/api/bids/:id/events` send `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, a `: connected` comment at once and a `: ping` comment every 15 s (HF-008). The smoke checks all four on the deployed URL.

### Workflows service (HF-030b)

`holdfast-workflows` is in the Blueprint with the same config as the web service (see [Settlement on Workflows](#settlement-on-workflows-hf-030b)). `SETTLEMENT_RUNNER` stays `inprocess` until its smoke is green. Switching means setting `SETTLEMENT_RUNNER=workflows` and `ALLOW_MOCK_DECLINE=true` (for the decline beat) on the web service, then a **manual** deploy.

### Auto-deploy off

Every service in `render.yaml` has `autoDeployTrigger: 'off'` (from 21:00 PST Nov 11 through recording, and permanently after submission; the rules forbid edits after the deadline). A push to `main` deploys nothing. Deploys are **Manual Deploy → Deploy latest commit** only. The Blueprint applies the setting on its next sync. Check each service's Settings → Build & Deploy → Auto-Deploy reads **Off**.

### Manual steps (in order, before 10:00 PST Nov 12 / 23:30 IST)

1. **Blueprint sync**: Dashboard → Blueprints → `holdfast` → *Sync* (or *Manual sync*). It creates `holdfast-demo-refresh` and turns auto-deploy off. Fill its prompted secrets: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_BRAND_EMAIL` (the sandbox **business** receiver), optionally `CHANNEL3_API_KEY`. Paste them straight from `.env` into the dashboard.
2. **Deploy the web service by hand** (Manual Deploy → latest commit) so the cron-pool fix is live. `/healthz` → `{"status":"ok","db":"ok"}`.
3. **Run the refresh by hand twice**: `holdfast-demo-refresh` → *Trigger Run*, wait for it to finish, then trigger it again. Each log ends with `demo:refresh done … none CREATED; 0 leftover bid(s)` and `judge listing /o/aurel-a7 … OPEN until …`. The second run's GET-check count covers the first book's 60 holds.
4. **Smoke** from a laptop (secrets from the environment, never printed):
   ```sh
   node scripts/smoke-deploy.mjs https://<host> --sse-minutes 10          # console live 10 min
   HOLDFAST_MCP_TOKEN=<W19 token> CHANNEL3_WEBHOOK_SECRET=… \
     node scripts/smoke-deploy.mjs https://<host>                          # + MCP + Channel3 event
   # Full money path (ends the judge listing): in the holdfast Shell `npm run demo:decline`, then
   node scripts/smoke-deploy.mjs https://<host> --clear --settle-timeout 600
   # …and trigger holdfast-demo-refresh once more so judges get a fresh OPEN listing.
   ```
   Then add `https://<host>/mcp` in Claude Desktop with the W19 token and call `get_book` (the smoke proves the server; this proves the client).
5. **Check the schedule**: `holdfast-demo-refresh` → Settings shows `0 8 * * *` and the next run time. Nothing ends it on Dec 21: it keeps running until someone deletes the cron after judging.
6. **Auto-deploy**: confirm **Off** on `holdfast`, `holdfast-workflows` and `holdfast-demo-refresh`.

Result: _not run yet_ (record the date, the two refresh logs' last lines and the smoke summary here).

## Checking a deploy

```sh
curl -s https://<host>/healthz        # {"status":"ok","db":"ok"}
curl -s https://<host>/api/healthz    # paypalMode "sandbox", settlementRunner "inprocess"
curl -sI https://<host>/              # the SPA demo hub (HF-007), same origin
```

- **A redeploy migrates and doesn't touch data**: Manual Deploy → *Deploy latest commit*. The pre-deploy log should read `[migrate] done: 0 applied, 1 already up to date`, and existing rows are unchanged. The runner skips applied files by checksum, and nothing seeds.
- **Workflows**: `npm run workflows:hello` from the web Shell, then the run in `holdfast-workflows` → Runs. Settlement: `npm run workflows:settle -- <listingId>`.

## Local equivalents

```sh
npm run build && npm run migrate && npm start      # uses the repo-root .env
curl -s localhost:3000/healthz
# Workflow task server locally (Render CLI):  render workflows dev -- node apps/workflows/dist/main.js
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx vitest run --maxWorkers=2 apps/workflows   # hello + settlement adapter against Postgres
```

## Notes

- Never use free instances. Free web services sleep: 30–60 s cold starts, dropped SSE, and a stopped in-process round tick.
- `SETTLEMENT_RUNNER` stays `inprocess` until HF-030b's 10-bid smoke on Render is green (steps above).
- To reach the database from a laptop (psql, manual seed), add your IP under `holdfast-db` → Networking. The Blueprint allows only the private network.
