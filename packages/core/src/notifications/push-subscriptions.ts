import type { Queryable } from '../db.js';
import type { WebPushSubscription } from './channels.js';
import type { Recipient } from './inbox.js';

/**
 * Web push subscriptions (HF-054b; api.md `POST /notifications/subscribe`). One row per browser
 * endpoint (`endpoint UNIQUE`). Subscribing again from the same browser re-points the row at the
 * signed-in recipient (a shared phone that switched accounts gets only the new account's alerts)
 * and un-revokes it. A brand device also records the brand user, so W11's per-user switches apply.
 */

export const MAX_ENDPOINT_LENGTH = 2048;

/** Push services are HTTPS; anything else (or a huge value) is refused before storage. */
export function isValidSubscription(sub: unknown): sub is WebPushSubscription {
  if (!sub || typeof sub !== 'object') return false;
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== 'string' || s.endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  try {
    if (new URL(s.endpoint).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  const b64 = /^[A-Za-z0-9_-]+={0,2}$/;
  return (
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys.auth === 'string' &&
    s.keys.p256dh.length <= 256 &&
    s.keys.auth.length <= 64 &&
    b64.test(s.keys.p256dh) &&
    b64.test(s.keys.auth)
  );
}

export async function savePushSubscription(
  q: Queryable,
  r: Recipient,
  brandUserId: string | null,
  sub: WebPushSubscription,
): Promise<{ id: string }> {
  const res = await q.query(
    `INSERT INTO push_subscriptions (recipient_type, recipient_id, brand_user_id, endpoint, keys)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET recipient_type = EXCLUDED.recipient_type, recipient_id = EXCLUDED.recipient_id,
           brand_user_id = EXCLUDED.brand_user_id, keys = EXCLUDED.keys, revoked_at = NULL
     RETURNING id`,
    [
      r.type,
      r.id,
      brandUserId,
      sub.endpoint,
      JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
    ],
  );
  return { id: (res.rows[0] as { id: string }).id };
}

/** Revoke the caller's own subscription for this endpoint. False = not theirs / unknown. */
export async function revokePushSubscription(
  q: Queryable,
  r: Recipient,
  endpoint: string,
): Promise<boolean> {
  const res = await q.query(
    `UPDATE push_subscriptions SET revoked_at = COALESCE(revoked_at, now())
      WHERE endpoint = $1 AND recipient_type = $2 AND recipient_id = $3`,
    [endpoint, r.type, r.id],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface ActiveSubscription extends WebPushSubscription {
  id: string;
  brandUserId: string | null;
  /** The brand user's W11 switches (jsonb); null for shoppers. */
  prefs: unknown;
}

export async function activePushSubscriptions(
  q: Queryable,
  r: Recipient,
): Promise<ActiveSubscription[]> {
  const res = await q.query(
    `SELECT ps.id, ps.endpoint, ps.keys, ps.brand_user_id, bu.notification_prefs AS prefs
       FROM push_subscriptions ps
       LEFT JOIN brand_users bu ON bu.id = ps.brand_user_id
      WHERE ps.recipient_type = $1 AND ps.recipient_id = $2 AND ps.revoked_at IS NULL
        -- A brand device whose user left the brand stops receiving.
        AND (ps.brand_user_id IS NULL OR bu.brand_id = ps.recipient_id)
      ORDER BY ps.created_at`,
    [r.type, r.id],
  );
  return (
    res.rows as {
      id: string;
      endpoint: string;
      keys: { p256dh: string; auth: string };
      brand_user_id: string | null;
      prefs: unknown;
    }[]
  ).map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    keys: row.keys,
    brandUserId: row.brand_user_id,
    prefs: row.prefs,
  }));
}

export async function markSubscriptionGone(q: Queryable, id: string): Promise<void> {
  await q.query(
    `UPDATE push_subscriptions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
    [id],
  );
}
