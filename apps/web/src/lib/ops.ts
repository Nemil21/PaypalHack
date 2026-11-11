import { formatUsd } from '@holdfast/shared';
import type { ApiRequest } from './api';

/**
 * W20 ops / audit (HF-058): the API shapes and the pure pieces of the screen (search query,
 * health tiles, the four actions with their confirm copy), kept here so they can be tested.
 */

export interface AuditRow {
  id: string;
  at: string;
  actorType: string;
  actorId: string | null;
  brandId: string | null;
  brandName: string | null;
  listingId: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  paypalId: string | null;
  requestId: string | null;
  data: Record<string, unknown>;
  /** The row itself carries the searched id (else it is the related bid's or settlement's). */
  direct: boolean;
}

export interface AuditPage {
  rows: AuditRow[];
  nextBeforeId: string | null;
}

export interface OpsHealth {
  status: 'healthy' | 'degraded';
  checkedAt: string;
  paypal: { ok: boolean; mode: string; ms: number | null; error: string | null };
  channel3: {
    ok: boolean;
    lastOkAt: string | null;
    consecutiveFailures: number;
    outageSince: string | null;
    lastError: string | null;
  };
  settlementQueue: {
    ok: boolean;
    depth: number;
    queued: number;
    running: number;
    retry: number;
    staleRunning: number;
    stalled: number;
    failedLast24h: number;
  };
  webhooks: {
    ok: boolean;
    lastHour: { paypal: number; channel3: number; replayed: number };
    unprocessed: number;
    failing: number;
    lastReceivedAt: string | null;
  };
  alerts: {
    ok: boolean;
    voidStuck: number;
    lastReconcile: { at: string; checked: number; mismatches: number } | null;
  };
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export const AUDIT_ENTITIES = [
  'bid',
  'settlement',
  'listing',
  'payout',
  'brand',
  'mandate',
  'ops',
  'reconcile',
  'cron',
] as const;

export interface AuditSearch {
  /** Brand, listing or bid UUID, or a PayPal id (order, authorization, capture, payout batch). */
  q: string;
  entity: string;
  /** `YYYY-MM-DD` (local day), inclusive. */
  from: string;
  to: string;
}

export const EMPTY_SEARCH: AuditSearch = { q: '', entity: '', from: '', to: '' };

/** `GET /api/admin/audit?…` for the form; `to` covers the whole day. */
export function auditSearchPath(s: AuditSearch, beforeId?: string | null): string {
  const p = new URLSearchParams();
  if (s.q.trim()) p.set('q', s.q.trim());
  if (s.entity) p.set('entity', s.entity);
  if (s.from) p.set('from', new Date(`${s.from}T00:00:00`).toISOString());
  if (s.to) {
    const end = new Date(`${s.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    p.set('to', end.toISOString());
  }
  if (beforeId) p.set('beforeId', beforeId);
  const qs = p.toString();
  return qs ? `/api/admin/audit?${qs}` : '/api/admin/audit';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s.trim());

/** Who did it, for the table: "Admin", "Sweeper", "Shopper"… plus the id. */
export function actorLabel(row: Pick<AuditRow, 'actorType' | 'actorId'>): string {
  const id = row.actorId ?? '';
  if (id.startsWith('cron:')) return `Cron · ${id.slice(5)}`;
  if (id.startsWith('reconcile:')) return `Reconcile · ${id.slice(10)}`;
  const type = row.actorType.toLowerCase().replace(/_/g, ' ');
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Alert rows (VOID_STUCK, RECONCILE_MISMATCH, failed runs) are tinted red in the table. */
export function isAlertRow(row: Pick<AuditRow, 'action' | 'data'>): boolean {
  return row.data?.alert === true || /(_FAILED|_STUCK|MISMATCH)$/.test(row.action);
}

/** One line of `data` for the table (reason, amount, error…). */
export function dataSummary(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof data.reason === 'string') parts.push(data.reason);
  if (typeof data.amountCents === 'number') parts.push(formatUsd(data.amountCents));
  if (typeof data.code === 'string') parts.push(data.code);
  if (typeof data.error === 'string') parts.push(data.error);
  if (typeof data.expected === 'string') parts.push(`expected ${data.expected}`);
  if (parts.length) return parts.join(' · ');
  const json = JSON.stringify(data);
  return json === '{}' ? '' : json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

// ---------------------------------------------------------------------------------------------
// Health tiles
// ---------------------------------------------------------------------------------------------

export interface HealthTile {
  key: 'paypal' | 'channel3' | 'queue' | 'webhooks' | 'alerts';
  label: string;
  value: string;
  caption: string;
  ok: boolean;
}

const ago = (iso: string | null, now: Date) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

export function healthTiles(h: OpsHealth, now = new Date()): HealthTile[] {
  const q = h.settlementQueue;
  const w = h.webhooks;
  const r = h.alerts.lastReconcile;
  return [
    {
      key: 'paypal',
      label: 'PayPal token',
      value: h.paypal.ok ? 'OK' : 'Failing',
      caption: h.paypal.ok
        ? `${h.paypal.mode}${h.paypal.ms !== null ? ` · ${h.paypal.ms} ms` : ''}`
        : (h.paypal.error ?? 'No token'),
      ok: h.paypal.ok,
    },
    {
      key: 'channel3',
      label: 'Channel3',
      value: h.channel3.ok ? 'Reachable' : 'Down',
      caption: h.channel3.ok
        ? `Last OK ${ago(h.channel3.lastOkAt, now)}`
        : `${h.channel3.consecutiveFailures} failures${
            h.channel3.lastError ? ` · ${h.channel3.lastError}` : ''
          }`,
      ok: h.channel3.ok,
    },
    {
      key: 'queue',
      label: 'Settlement queue',
      value: String(q.depth),
      caption: q.ok
        ? `${q.queued} queued · ${q.running} running · ${q.retry} retry`
        : `${q.staleRunning} stuck running · ${q.stalled} not picked up`,
      ok: q.ok,
    },
    {
      key: 'webhooks',
      label: 'Webhooks · last hour',
      value: String(w.lastHour.paypal + w.lastHour.channel3),
      caption: w.ok
        ? `PayPal ${w.lastHour.paypal} · Channel3 ${w.lastHour.channel3}${
            w.lastHour.replayed ? ` (${w.lastHour.replayed} replayed)` : ''
          }`
        : `${w.failing} failing to process`,
      ok: w.ok,
    },
    {
      key: 'alerts',
      label: 'Alerts',
      value: String(h.alerts.voidStuck + (r?.mismatches ?? 0)),
      caption: `${h.alerts.voidStuck} stuck voids · ${
        r ? `reconcile ${ago(r.at, now)}: ${r.mismatches} mismatches` : 'no reconcile yet'
      }`,
      ok: h.alerts.ok,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export type OpsActionKind = 'verify-brand' | 'retry-settlement' | 'replay-price' | 'void-dangling';

export interface OpsActionInput {
  brandId?: string;
  listingId?: string;
  /** Dollars as typed, e.g. "199" or "199.50". */
  price?: string;
}

export interface OpsActionSpec {
  kind: OpsActionKind;
  label: string;
  /** What the confirm dialog says will happen. */
  confirm: string;
  fields: ReadonlyArray<'brandId' | 'listingId' | 'price'>;
  /** Shown on the button and in the dialog: replays are demo-only. */
  demo?: boolean;
}

export const OPS_ACTIONS: readonly OpsActionSpec[] = [
  {
    kind: 'verify-brand',
    label: 'Verify brand',
    confirm: 'Mark this brand VERIFIED so it can publish listings.',
    fields: ['brandId'],
  },
  {
    kind: 'retry-settlement',
    label: 'Retry settlement',
    confirm:
      'Make this listing’s RETRY settlements due now and re-kick the runner. Refused once the listing has settled.',
    fields: ['listingId'],
  },
  {
    kind: 'replay-price',
    label: 'Replay price event',
    confirm:
      'Replay a labelled public price drop for this listing. Held bids above the new price are released.',
    fields: ['listingId', 'price'],
    demo: true,
  },
  {
    kind: 'void-dangling',
    label: 'Void dangling holds',
    confirm:
      'Run the hold sweeper now: every hold whose listing no longer needs it is voided at PayPal.',
    fields: [],
  },
];

export type ActionRequest = { ok: true; request: ApiRequest } | { ok: false; error: string };

/** Dollars → cents; null when not a positive amount with at most two decimals. */
export function dollarsToCents(s: string): number | null {
  const t = s.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

export function actionRequest(kind: OpsActionKind, input: OpsActionInput): ActionRequest {
  const brandId = input.brandId?.trim() ?? '';
  const listingId = input.listingId?.trim() ?? '';
  switch (kind) {
    case 'verify-brand':
      if (!isUuid(brandId)) return { ok: false, error: 'Enter a brand id.' };
      return {
        ok: true,
        request: {
          method: 'POST',
          path: `/api/admin/brands/${encodeURIComponent(brandId)}/verify`,
        },
      };
    case 'retry-settlement':
      if (!isUuid(listingId)) return { ok: false, error: 'Enter a listing id.' };
      return {
        ok: true,
        request: {
          method: 'POST',
          path: `/api/admin/listings/${encodeURIComponent(listingId)}/retry-settlement`,
        },
      };
    case 'replay-price': {
      if (!isUuid(listingId)) return { ok: false, error: 'Enter a listing id.' };
      const priceCents = dollarsToCents(input.price ?? '');
      if (priceCents === null) return { ok: false, error: 'Enter the new public price.' };
      return {
        ok: true,
        request: {
          method: 'POST',
          path: '/api/admin/replay-price-event',
          body: { listingId, priceCents },
        },
      };
    }
    case 'void-dangling':
      return { ok: true, request: { method: 'POST', path: '/api/admin/void-dangling' } };
  }
}

/** The toast after a successful action. */
export function actionResultText(kind: OpsActionKind, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'verify-brand':
      return b.alreadyVerified
        ? `${String(b.name ?? 'Brand')} was already verified.`
        : `${String(b.name ?? 'Brand')} is verified.`;
    case 'retry-settlement':
      return `${Number(b.retried ?? 0)} settlements made due${b.kicked ? ', runner kicked' : ''}.`;
    case 'replay-price':
      if (b.duplicate) return 'That price event was already processed.';
      return `Replayed: ${Number(b.releasedCount ?? 0)} holds released.`;
    case 'void-dangling': {
      const r = (b.result ?? {}) as Record<string, number>;
      return `Sweep done: ${r.voided ?? 0} voided, ${r.voidFailed ?? 0} void failures, ${
        r.stuck ?? 0
      } stuck.`;
    }
  }
}
