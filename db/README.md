# db

Postgres schema for Holdfast (HF-002) and the migration runner. The schema is frozen at CP1 (05:30 PST Nov 11); any later change is a **new** numbered file in `migrations/` and needs a CP sign-off. Never edit an applied migration: the runner stores a sha256 checksum per file and refuses to run if one changed.

- `migrations/0001_init.sql`: every table, CHECK, trigger and index from `docs/spec/data-model.md`.
- `migrate.mjs`: applies pending files in name order, one transaction per file, under an advisory lock. Re-running is a no-op. Run it only from Render's `preDeployCommand` (HF-048a), not at app boot.

```sh
DATABASE_URL=postgres://... npm run migrate -w @holdfast/db     # or: cd db && npm run migrate
```

From code: `import { migrate } from '@holdfast/db/migrate.mjs'` (accepts `{ connectionString }` or an open `pg` `{ client }`).

## Tests

Integration tests create a throwaway `holdfast_test_*` database, migrate it twice and check every HF-002 constraint. They skip when `TEST_DATABASE_URL` is unset.

```sh
docker run -d --rm --name holdfast-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test -w @holdfast/db
```

CI runs the same against a Postgres 16 service (`.github/workflows/db.yml`).

## Invariants enforced in the database

- `audit_events` is append-only: a statement-level trigger rejects UPDATE and DELETE for every role (owner and superuser too). If a `holdfast_app` role exists at migrate time, its UPDATE/DELETE/TRUNCATE grants are revoked as well.
- INV-5 (M1): a `CAPTURE` settlement's `amount_cents` must equal `bids.amount_cents` and `bids.authorized_amount_cents` (trigger), and `bids.authorized_amount_cents` must equal `amount_cents` once set (CHECK).
- D6 deadlines: window ≤ 48 h, rounds end ≤ close + 6 h and ≤ opens + 54 h, clear deadline ≤ opens + 60 h.
- `one_held_bid`, one HELD bid per intent, `replaces_bid_id` UNIQUE (D3), `unique(shopper_id, idempotency_key)`, one live listing per product, one non-FAILED payout per listing (M4), `unique(bid_id, action)` on settlements, `authorized_domains` ≤ 25 (D17).
- Agent messages and pending actions carry `shopper_id` with a composite FK to their conversation, so they cannot cross shoppers (M24).
