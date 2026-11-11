import { createHash } from 'node:crypto';
import { audit } from '../audit.js';
import { cancelBid, cancelBidResponse } from '../bid-cancel.js';
import { raiseBid, raiseBidResponse } from '../bid-raise.js';
import { placeBid, placeBidResponse, type PlaceBidDeps } from '../bids.js';
import type { Queryable } from '../db.js';
import type { IdempotentResponse } from '../idempotency.js';
import { appendMessage, isUuid } from './history.js';

/**
 * Pending money actions (HF-039; B10, M24; data-model §agent_pending_actions).
 *
 * The model never moves money. `place_bid`, `raise_bid` and `cancel_bid` only store their
 * arguments here and end the turn with `confirm_required`. `POST /agent/actions/:id/confirm`
 * then runs the **stored** arguments (never re-asking the model) with `Idempotency-Key =
 * action.id`.
 *
 *   PENDING ──confirm (owner, not expired)──▶ CONFIRMED ──executed──▶ EXECUTED (result stored)
 *      │
 *      └──expires_at passed──▶ EXPIRED
 *
 * The PENDING→CONFIRMED claim is a conditional UPDATE, so two tabs confirming at once run the
 * action once; the loser waits for the winner's stored result. Even a crash between the claim and
 * EXECUTED is safe to re-run: the bid service replays by idempotency key.
 */

export type MoneyTool = 'place_bid' | 'raise_bid' | 'cancel_bid';
export type ActionStatus = 'PENDING' | 'CONFIRMED' | 'EXECUTED' | 'EXPIRED' | 'REJECTED';

export interface PlaceBidArgs {
  listingId: string;
  amountCents: number;
  /** The shopper's ACTIVE covering mandate, so `ABOVE_MANDATE_MAX` is re-checked at landing. */
  mandateId: string | null;
}
export interface RaiseBidArgs {
  bidId: string;
  amountCents: number;
}
export interface CancelBidArgs {
  bidIds: string[];
}
export type ActionArgs = PlaceBidArgs | RaiseBidArgs | CancelBidArgs;

export interface PendingActionRow {
  id: string;
  conversation_id: string;
  shopper_id: string;
  tool: MoneyTool;
  args: ActionArgs & { toolUseId?: string };
  status: ActionStatus;
  result: ActionResult | null;
  expires_at: Date;
  confirmed_at: Date | null;
  executed_at: Date | null;
}

/** What confirm answers, stored on the action so a second confirm returns the same thing. */
export interface ActionResult {
  status: number;
  body: unknown;
}

/** A pending action lives this long (the confirm card says so). */
export const ACTION_TTL_MS = 10 * 60 * 1000;
/** A CONFIRMED action whose executor vanished is re-run (idempotently) after this long. */
export const STALE_CONFIRM_MS = 30_000;

/**
 * The action id for a tool call: a UUID derived from (conversation, `tool_use.id`), so a retried
 * tool call maps to the same row and never creates a second pending action.
 */
export function actionIdFor(conversationId: string, toolUseId: string): string {
  const h = createHash('sha256').update(`agent-action:${conversationId}:${toolUseId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5-style (name-based)
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Create (or find, on a retried tool call) the pending action for a money tool call. */
export async function createPendingAction(
  q: Queryable,
  input: {
    conversationId: string;
    shopperId: string;
    toolUseId: string;
    tool: MoneyTool;
    args: ActionArgs;
    ttlMs?: number;
  },
): Promise<PendingActionRow> {
  const id = actionIdFor(input.conversationId, input.toolUseId);
  await q.query(
    `INSERT INTO agent_pending_actions (id, conversation_id, shopper_id, tool, args, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now() + $6::float8 * interval '1 millisecond')
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      input.conversationId,
      input.shopperId,
      input.tool,
      JSON.stringify({ ...input.args, toolUseId: input.toolUseId }),
      input.ttlMs ?? ACTION_TTL_MS,
    ],
  );
  const row = await findAction(q, input.shopperId, id);
  if (!row) throw new Error('pending action vanished');
  return row;
}

export async function findAction(
  q: Queryable,
  shopperId: string,
  actionId: string,
): Promise<PendingActionRow | null> {
  if (!isUuid(actionId)) return null;
  const res = await q.query(
    `SELECT * FROM agent_pending_actions WHERE id = $1 AND shopper_id = $2`,
    [actionId, shopperId],
  );
  return (res.rows[0] as PendingActionRow | undefined) ?? null;
}

export type ConfirmOutcome =
  | { kind: 'executed'; action: PendingActionRow; result: ActionResult; replayed: boolean }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'rejected' }
  /** Another confirm is still executing it. */
  | { kind: 'in_progress' }
  /** Can't be confirmed inline (no saved payment method): the card deep-links to W12. */
  | { kind: 'needs_offer_page'; offerUrl: string | null };

export interface ConfirmDeps {
  money: PlaceBidDeps;
  /** Test seam for the "another tab is executing" wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a second confirm waits for the first one's result. Default 15 s. */
  waitMs?: number;
}

/** Inline (CIT) confirms need a saved payment method; otherwise W12 is the confirm. */
export async function offerPageUrl(
  q: Queryable,
  listingId: string,
  amountCents: number,
): Promise<string | null> {
  const res = await q.query(`SELECT slug FROM listings WHERE id = $1`, [listingId]);
  const slug = (res.rows[0] as { slug: string | null } | undefined)?.slug;
  return slug ? `/o/${encodeURIComponent(slug)}?amount=${amountCents}&src=agent` : null;
}

async function hasVault(q: Queryable, shopperId: string): Promise<boolean> {
  const res = await q.query(`SELECT paypal_vault_id FROM shoppers WHERE id = $1`, [shopperId]);
  return !!(res.rows[0] as { paypal_vault_id: string | null } | undefined)?.paypal_vault_id;
}

/** `POST /agent/actions/:id/confirm`. Owner only; another shopper's action is `not_found`. */
export async function confirmAction(
  deps: ConfirmDeps,
  shopperId: string,
  actionId: string,
): Promise<ConfirmOutcome> {
  const pool = deps.money.db.pool;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const existing = await findAction(pool, shopperId, actionId);
  if (!existing) return { kind: 'not_found' };

  // A place_bid with no saved payment method is confirmed on the offer page instead (M24).
  if (existing.status === 'PENDING' && existing.tool === 'place_bid') {
    if (!(await hasVault(pool, shopperId))) {
      const args = existing.args as PlaceBidArgs;
      return {
        kind: 'needs_offer_page',
        offerUrl: await offerPageUrl(pool, args.listingId, args.amountCents),
      };
    }
  }

  const claimed = await pool.query(
    `UPDATE agent_pending_actions
        SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now()
      WHERE id = $1 AND shopper_id = $2 AND status = 'PENDING' AND expires_at > now()
      RETURNING *`,
    [actionId, shopperId],
  );
  let action = claimed.rows[0] as PendingActionRow | undefined;

  if (!action) {
    const deadline = Date.now() + (deps.waitMs ?? 15_000);
    for (;;) {
      const now = await findAction(pool, shopperId, actionId);
      if (!now) return { kind: 'not_found' };
      if (now.status === 'EXECUTED' && now.result) {
        return { kind: 'executed', action: now, result: now.result, replayed: true };
      }
      if (now.status === 'REJECTED') return { kind: 'rejected' };
      if (now.status === 'EXPIRED') return { kind: 'expired' };
      if (now.status === 'PENDING') {
        // Not claimable, so it expired: record that once.
        await pool.query(
          `UPDATE agent_pending_actions SET status = 'EXPIRED', updated_at = now()
            WHERE id = $1 AND status = 'PENDING' AND expires_at <= now()`,
          [actionId],
        );
        return { kind: 'expired' };
      }
      // CONFIRMED: another confirm is executing. A stale claim (crashed executor) is re-run;
      // the bid service replays by key, so that cannot place a second bid.
      if (
        now.confirmed_at &&
        Date.now() - new Date(now.confirmed_at).getTime() > STALE_CONFIRM_MS
      ) {
        action = now;
        break;
      }
      if (Date.now() >= deadline) return { kind: 'in_progress' };
      await sleep(100);
    }
  }

  const result = await execute(deps.money, action);
  const done = await pool.query(
    `UPDATE agent_pending_actions
        SET status = 'EXECUTED', result = $2::jsonb, executed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'CONFIRMED'
      RETURNING *`,
    [action.id, JSON.stringify(result)],
  );
  const executed = done.rows[0] as PendingActionRow | undefined;
  if (!executed) {
    // A stale re-run raced the original executor: answer with whatever was stored first.
    const stored = await findAction(pool, shopperId, actionId);
    return {
      kind: 'executed',
      action: stored ?? action,
      result: stored?.result ?? result,
      replayed: true,
    };
  }

  await audit(pool, {
    actorType: 'BUYER_AGENT',
    actorId: shopperId,
    listingId: 'listingId' in action.args ? action.args.listingId : null,
    entity: 'agent_action',
    entityId: action.id,
    action: 'AGENT_ACTION_EXECUTED',
    data: { tool: action.tool, args: action.args, httpStatus: result.status },
  });
  // The model learns the outcome on its next turn. Its tool_use already has a tool_result
  // (`confirm_required`), so this is a server note, not a second tool_result.
  await appendMessage(pool, shopperId, action.conversation_id, {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `[Holdfast server] The shopper confirmed action ${action.id} (${action.tool}). Result: ${JSON.stringify(
          result.body,
        )}`,
      },
    ],
  });
  return { kind: 'executed', action: executed, result, replayed: false };
}

/** Run the stored arguments. Never reads anything the model said after the action was stored. */
async function execute(money: PlaceBidDeps, action: PendingActionRow): Promise<ActionResult> {
  const actor = { type: 'BUYER_AGENT', id: action.shopper_id };
  switch (action.tool) {
    case 'place_bid': {
      const args = action.args as PlaceBidArgs;
      const result = await placeBid(money, {
        shopperId: action.shopper_id,
        listingId: args.listingId,
        amountCents: args.amountCents,
        paymentMethod: 'VAULT',
        mandateId: args.mandateId,
        source: 'BUYER_AGENT',
        // The shopper pressed confirm: a customer-initiated vault hold (CIT).
        initiator: 'CUSTOMER',
        idempotencyKey: action.id,
        actor,
      });
      return asResult(placeBidResponse(result));
    }
    case 'raise_bid': {
      const args = action.args as RaiseBidArgs;
      const result = await raiseBid(money, {
        bidId: args.bidId,
        amountCents: args.amountCents,
        shopperId: action.shopper_id,
        idempotencyKey: action.id,
        actor,
        // Shopper-confirmed, so not agent-capped (M11) and customer-initiated.
        agentInitiated: false,
        initiator: 'CUSTOMER',
      });
      return asResult(raiseBidResponse(result));
    }
    case 'cancel_bid': {
      const args = action.args as CancelBidArgs;
      const results = [];
      for (const bidId of args.bidIds) {
        const r = await cancelBid(money, { bidId, shopperId: action.shopper_id, actor });
        results.push({ bidId, ...asResult(cancelBidResponse(r)) });
      }
      const allOk = results.every((r) => r.status < 400);
      return { status: allOk ? 200 : 207, body: { cancelled: results } };
    }
  }
}

const asResult = (r: IdempotentResponse): ActionResult => ({ status: r.status, body: r.body });
