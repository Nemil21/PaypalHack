# 15: Audit Log & Ops/Admin

**Priority:** P0 (audit writes), P1 (ops UI) · **Owner:** A · **Effort:** 4 h

## Purpose
Every money action is traceable: who did it (human, agent, watcher, workflow), when, and with which PayPal ID. This builds judge trust and is the basis for disputes.

## Logic
1. `audit(actorType, actorId, entity, entityId, action, paypalId?, data?)` is called in the same transaction as each state change. PayPal calls are audited as `*_REQUESTED` / `*_SUCCEEDED` pairs.
2. The `audit_events` table is append-only (no UPDATE/DELETE grants, plus a trigger).
3. The bid timeline (W15/M04) is just audit events filtered by bid, rendered as friendly steps.
4. **Ops page W20** (admins from `ADMIN_EMAILS`):
   - search by brand, listing, bid or PayPal ID;
   - a table of events;
   - a health panel: PayPal token, Channel3 reachability, settlement queue depth, webhooks received in the last hour;
   - actions: verify brand, retry settlement (refused once SETTLED), replay price event (demo, labelled), void dangling holds (calls the sweeper).
5. **Reconcile:** `reconcile:holds` (P0, in the sweeper ticket; D19) GETs every non-captured authorization and voids any that is CREATED but not live; `demo:reset` runs sweep → reconcile → verify → truncate. The nightly settlement-vs-PayPal comparison for the last 24 h (flag mismatches) ships with the ops screen (P1).

## Acceptance criteria
- [ ] Every PayPal call made by the app has a matching audit row with the PayPal ID.
- [ ] The bid timeline shows: held → (signals) → won/lost → captured/voided, with times.
- [ ] Admin actions are themselves audited.

## Test plan
Integration: run the demo flow and assert counts of audit rows per action. Manual: W20 search by capture ID.
