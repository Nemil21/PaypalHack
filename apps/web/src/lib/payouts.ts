import {
  formatUsd,
  parseShipmentCsv,
  statementsCsv,
  type BrandPayoutRow,
  type ListingStatement,
  type ShipmentCsvError,
  type ShipmentRosterRow,
  type ShipmentUploadBody,
} from '@holdfast/shared';
import type { BadgeTone } from '../components/ui';

/**
 * W09 payouts & reports (HF-059b; screens.md §W09, features/12 §Logic 3–4). Pure helpers so the
 * page stays thin and the states are unit-tested: empty / list / upload validating / upload
 * errors per row / success.
 */

export const PAYOUTS_PATH = '/api/brands/me/payouts';
export const REPORTS_PATH = '/api/brands/me/reports';
export const shipmentsPath = (listingId: string) =>
  `/api/listings/${encodeURIComponent(listingId)}/shipments`;

export const usd = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '—' : formatUsd(cents);

/** Payout attempt → badge. */
export function payoutBadge(p: Pick<BrandPayoutRow, 'status' | 'itemStatus'>): {
  label: string;
  tone: BadgeTone;
} {
  switch (p.status) {
    case 'SUCCESS':
      return { label: 'Paid', tone: 'success' };
    case 'FAILED':
      return { label: p.itemStatus === 'UNCLAIMED' ? 'Unclaimed' : 'Failed', tone: 'danger' };
    case 'PENDING_UNKNOWN':
      return { label: 'Confirming', tone: 'held' };
    default:
      return { label: 'Pending', tone: 'held' };
  }
}

/** Shipment state of one roster row, as the brand reads it. */
export function shipmentBadge(row: Pick<ShipmentRosterRow, 'trackable' | 'shipment'>): {
  label: string;
  tone: BadgeTone;
} {
  const s = row.shipment;
  if (!row.trackable && !s) return { label: 'No PayPal order', tone: 'sim' };
  if (!s) return { label: 'Not shipped', tone: 'neutral' };
  switch (s.status) {
    case 'SHIPPED':
      return { label: 'Shipped', tone: 'success' };
    case 'DELIVERED':
      return { label: 'Delivered', tone: 'success' };
    case 'TRACKING_FAILED':
      return { label: 'PayPal refused', tone: 'danger' };
    default:
      return { label: s.errorCode ? 'Retry needed' : 'Sending', tone: 'held' };
  }
}

/** Whether a roster row still takes manual tracking entry. */
export const canEnterTracking = (row: Pick<ShipmentRosterRow, 'trackable' | 'shipment'>) =>
  row.trackable && row.shipment?.status !== 'SHIPPED' && row.shipment?.status !== 'DELIVERED';

export type UploadState =
  | { kind: 'idle' }
  /** Parsed in the browser; `errors` are rows the server would reject anyway. */
  | { kind: 'validating'; fileName: string; csv: string; rows: number; errors: ShipmentCsvError[] }
  | { kind: 'uploading'; fileName: string }
  | { kind: 'done'; fileName: string; result: ShipmentUploadBody }
  | { kind: 'failed'; fileName: string; message: string };

/** Client-side check of a dropped file before anything is sent (the "upload validating" state). */
export function validateUpload(fileName: string, csv: string): UploadState {
  const { rows, errors } = parseShipmentCsv(csv);
  return { kind: 'validating', fileName, csv, rows: rows.length, errors };
}

export function uploadSummary(result: ShipmentUploadBody): {
  tone: 'success' | 'mixed' | 'error';
  text: string;
} {
  const shipped = result.results.filter((r) => r.ok && !r.replayed).length;
  const already = result.results.filter((r) => r.ok && r.replayed).length;
  const parts = [
    shipped ? `${shipped} sent to PayPal` : null,
    already ? `${already} already tracked` : null,
    result.errorCount ? `${result.errorCount} need fixing` : null,
  ].filter(Boolean);
  return {
    tone: result.errorCount === 0 ? 'success' : result.okCount === 0 ? 'error' : 'mixed',
    text: parts.join(' · ') || 'Nothing to upload.',
  };
}

/** `YYYY-MM-DD` inputs → the reports query string. */
export function reportQuery(from: string, to: string): string {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Download a CSV the API renders (`Accept: text/csv`) through the session cookie. A plain link
 * would send `Accept: text/html` and get JSON back.
 */
export async function downloadCsv(path: string, fileName: string): Promise<void> {
  const res = await fetch(path, { headers: { Accept: 'text/csv' }, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * One listing's statement as a CSV (UI-GAPS W09): the same columns as the API's statements export
 * (shared `statementsCsv`), built in the browser from the statement already on screen.
 */
export function statementDownload(s: ListingStatement): { fileName: string; csv: string } {
  const slug =
    s.productTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'listing';
  const day = s.clearedAt ? s.clearedAt.slice(0, 10) : 'uncleared';
  return { fileName: `holdfast-statement-${slug}-${day}.csv`, csv: statementsCsv([s]) };
}

/** Save text the page already has as a file (no round trip). */
export function saveTextFile(text: string, fileName: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
