import { z } from 'zod';
import { centsToDecimal } from './money.js';
import type { ListingStatus, PayoutStatus } from './status.js';

/**
 * W09 payouts, reports and shipment tracking (HF-059b; features/12 §Logic 3–4, api.md
 * §`/brands/me/payouts`, §`/brands/me/reports`, §`POST /listings/:id/shipments`).
 *
 * Money rule (B7, D8): gross is the sum of COMPLETED **real** captures. Simulated money (a
 * simulated shopper or a `SIM` bid) is reported separately and never in gross, fee or net.
 */

// ---------------------------------------------------------------------------------------------
// Shipments

export const SHIPMENT_STATUSES = [
  'PENDING',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'TRACKING_FAILED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const MAX_CARRIER_LENGTH = 64;
export const MAX_TRACKING_NUMBER_LENGTH = 64;
/** Rows per CSV upload; bigger files are split by the brand. */
export const MAX_SHIPMENT_CSV_ROWS = 500;

const TRACKING_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

export const shipmentRequestSchema = z.object({
  bidId: z.string().uuid(),
  carrier: z.string().trim().min(1, 'carrier is required').max(MAX_CARRIER_LENGTH),
  trackingNumber: z
    .string()
    .trim()
    .min(1, 'tracking number is required')
    .max(MAX_TRACKING_NUMBER_LENGTH)
    .regex(TRACKING_NUMBER, 'letters, digits, spaces and dashes only'),
});
export type ShipmentRequest = z.infer<typeof shipmentRequestSchema>;

export interface ShipmentView {
  shipmentId: string;
  bidId: string;
  listingId: string;
  carrier: string | null;
  trackingNumber: string | null;
  status: ShipmentStatus;
  /** PayPal's tracker id (`<captureId>-<trackingNumber>`) once `pp.track` succeeded. */
  paypalTrackerId: string | null;
  shippedAt: string | null;
  /** PayPal issue code of the last failed `pp.track`, when status is TRACKING_FAILED. */
  errorCode: string | null;
}

/** `POST /listings/:id/shipments` answer: 201 the first time, 200 when it was already tracked. */
export interface ShipmentResponseBody {
  shipment: ShipmentView;
  /** True when no new PayPal tracker was added (already SHIPPED, or PayPal replayed it). */
  replayed: boolean;
}

/** One winner on the shipping roster (`GET /listings/:id/shipments`). No shopper PII but a name. */
export interface ShipmentRosterRow {
  bidId: string;
  /** Shopper display name, else "Winner #n". */
  winnerLabel: string;
  amountCents: number;
  bidStatus: string;
  /** False for simulated winners and bids without a completed capture: nothing to track. */
  trackable: boolean;
  shipment: ShipmentView | null;
}

export interface ShipmentRosterBody {
  listingId: string;
  productTitle: string;
  rows: ShipmentRosterRow[];
}

export type ShipmentUploadRowResult =
  | { row: number; bidId: string; ok: true; replayed: boolean; shipment: ShipmentView }
  | { row: number; bidId: string | null; ok: false; error: { code: string; message: string } };

/** `POST /listings/:id/shipments/csv`: per-row results; the upload never fails as a whole. */
export interface ShipmentUploadBody {
  listingId: string;
  results: ShipmentUploadRowResult[];
  okCount: number;
  errorCount: number;
}

// ---------------------------------------------------------------------------------------------
// CSV

/** Header the roster export writes and the upload reads (aliases accepted, any case). */
export const SHIPMENT_CSV_COLUMNS = ['bidId', 'carrier', 'trackingNumber'] as const;
const HEADER_ALIASES: Record<string, (typeof SHIPMENT_CSV_COLUMNS)[number]> = {
  bidid: 'bidId',
  bid_id: 'bidId',
  bid: 'bidId',
  carrier: 'carrier',
  trackingnumber: 'trackingNumber',
  tracking_number: 'trackingNumber',
  tracking: 'trackingNumber',
};

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Spreadsheet formula injection guard (`=`, `+`, `-`, `@` at the start of a cell). */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: (string | number | null)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export interface ParsedShipmentRow {
  /** 1-based data row number (the header is row 0). */
  row: number;
  input: ShipmentRequest;
}
export interface ShipmentCsvError {
  row: number;
  bidId: string | null;
  message: string;
}

/**
 * Parse and validate a tracking upload. Used by the W09 drop zone (instant "upload validating"
 * feedback) and by the API (the authority). A bad row never sinks the others.
 */
export function parseShipmentCsv(text: string): {
  rows: ParsedShipmentRow[];
  errors: ShipmentCsvError[];
} {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
  const missing = SHIPMENT_CSV_COLUMNS.filter((c) => !header.includes(c));
  if (table.length === 0 || missing.length) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          bidId: null,
          message: `Header must include ${SHIPMENT_CSV_COLUMNS.join(', ')}${
            missing.length ? ` (missing ${missing.join(', ')})` : ''
          }.`,
        },
      ],
    };
  }
  const data = table.slice(1);
  if (data.length > MAX_SHIPMENT_CSV_ROWS) {
    return {
      rows: [],
      errors: [
        { row: 0, bidId: null, message: `At most ${MAX_SHIPMENT_CSV_ROWS} rows per upload.` },
      ],
    };
  }
  const rows: ParsedShipmentRow[] = [];
  const errors: ShipmentCsvError[] = [];
  const seen = new Set<string>();
  data.forEach((cells, i) => {
    const row = i + 1;
    const record: Record<string, string> = {};
    header.forEach((col, j) => {
      if (col) record[col] = (cells[j] ?? '').trim();
    });
    const parsed = shipmentRequestSchema.safeParse(record);
    const bidId = record.bidId || null;
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      errors.push({ row, bidId, message: `${issue.path.join('.') || 'row'}: ${issue.message}` });
      return;
    }
    if (seen.has(parsed.data.bidId)) {
      errors.push({ row, bidId, message: 'bidId appears more than once in this file' });
      return;
    }
    seen.add(parsed.data.bidId);
    rows.push({ row, input: parsed.data });
  });
  return { rows, errors };
}

// ---------------------------------------------------------------------------------------------
// Payouts and statements

/** One payout attempt in the W09 payouts table (`GET /brands/me/payouts`), newest first. */
export interface BrandPayoutRow {
  payoutId: string;
  listingId: string;
  productTitle: string;
  listingStatus: ListingStatus;
  attempt: number;
  status: PayoutStatus;
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  /** PayPal payout item status (SUCCESS, UNCLAIMED, …) once polled. */
  itemStatus: string | null;
  paypalBatchId: string | null;
  failureReason: string | null;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
}

export interface BrandPayoutsBody {
  payouts: BrandPayoutRow[];
}

/**
 * A per-listing statement (features/12 §Logic 4). Every money number is derived from the
 * listing's COMPLETED capture records at read time, so the statement always matches them.
 */
export interface ListingStatement {
  listingId: string;
  productTitle: string;
  listingStatus: ListingStatus;
  clearedAt: string | null;
  /** Lowest winning bid at Clear (winners pay their own bids). */
  cutoffCents: number | null;
  /** COMPLETED real captures. */
  units: number;
  grossRealCents: number;
  feeBps: number;
  feeCents: number;
  netCents: number;
  /** gross_real / units, rounded half up; null with no units. */
  averageCents: number | null;
  /** COMPLETED captures of simulated shoppers / `SIM` bids; never paid out. */
  unitsSimulated: number;
  grossSimulatedCents: number;
  payoutStatus: PayoutStatus | null;
  payoutAttempt: number | null;
}

export interface StatementTotals {
  units: number;
  grossRealCents: number;
  feeCents: number;
  netCents: number;
  grossSimulatedCents: number;
}

/** `GET /brands/me/reports?from&to`: listings cleared in `[from, to)`. */
export interface BrandReportBody {
  from: string | null;
  to: string | null;
  statements: ListingStatement[];
  totals: StatementTotals;
}

export const brandReportQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
    to: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  });

export function averageCents(grossCents: number, units: number): number | null {
  return units > 0 ? Math.floor((grossCents * 2 + units) / (units * 2)) : null;
}

export function statementTotals(statements: readonly ListingStatement[]): StatementTotals {
  return statements.reduce<StatementTotals>(
    (t, s) => ({
      units: t.units + s.units,
      grossRealCents: t.grossRealCents + s.grossRealCents,
      feeCents: t.feeCents + s.feeCents,
      netCents: t.netCents + s.netCents,
      grossSimulatedCents: t.grossSimulatedCents + s.grossSimulatedCents,
    }),
    { units: 0, grossRealCents: 0, feeCents: 0, netCents: 0, grossSimulatedCents: 0 },
  );
}

export const STATEMENT_CSV_HEADER = [
  'listing_id',
  'product',
  'status',
  'cleared_at',
  'cutoff_usd',
  'units',
  'gross_usd',
  'fee_bps',
  'fee_usd',
  'net_usd',
  'average_usd',
  'simulated_units',
  'simulated_gross_usd',
  'payout_status',
] as const;

const usd = (cents: number | null) => (cents === null ? null : centsToDecimal(cents));

/** The report as CSV (`Accept: text/csv`). Dollars as decimals, never floats. */
export function statementsCsv(statements: readonly ListingStatement[]): string {
  return toCsv(
    STATEMENT_CSV_HEADER,
    statements.map((s) => [
      s.listingId,
      s.productTitle,
      s.listingStatus,
      s.clearedAt,
      usd(s.cutoffCents),
      s.units,
      usd(s.grossRealCents),
      s.feeBps,
      usd(s.feeCents),
      usd(s.netCents),
      usd(s.averageCents),
      s.unitsSimulated,
      usd(s.grossSimulatedCents),
      s.payoutStatus,
    ]),
  );
}
