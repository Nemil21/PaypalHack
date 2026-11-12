import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import type {
  BrandPayoutsBody,
  BrandReportBody,
  ListingStatement,
  ShipmentResponseBody,
  ShipmentRosterBody,
  ShipmentRosterRow,
  ShipmentUploadBody,
} from '@holdfast/shared';
import { OrderTimeline } from '../../components/bryntum/OrderTimeline';
import { PageHeader } from '../../components/layout/AppShell';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Skeleton,
  StatTile,
  useToast,
} from '../../components/ui';
import { ApiAction, ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  canEnterTracking,
  downloadCsv,
  PAYOUTS_PATH,
  payoutBadge,
  REPORTS_PATH,
  reportQuery,
  shipmentBadge,
  shipmentsPath,
  uploadSummary,
  usd,
  validateUpload,
  type UploadState,
} from '../../lib/payouts';
import { paths } from '../../lib/routes';
import { formatWhen } from '../bids/format';
import { useBrand } from './BrandGate';

/**
 * W09 Payouts & reports (HF-059b; screens.md §W09, features/12 §Logic 3–4): totals, the payouts
 * table, per-listing statements (gross = COMPLETED real captures, fee, net, units, cutoff,
 * average; simulated money apart) with CSV export, and per-listing tracking entry: manual rows
 * or a CSV drop zone, validated in the browser, then per-row results from the API.
 */
export function PayoutsPage() {
  const { me } = useBrand();
  const canShip = me.role === 'OWNER' || me.role === 'MANAGER';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [payouts, setPayouts] = useState<BrandPayoutsBody | null>(null);
  const [report, setReport] = useState<BrandReportBody | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();
  const fromId = useId();
  const toId = useId();

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        api.request<BrandPayoutsBody>({ method: 'GET', path: PAYOUTS_PATH }),
        api.request<BrandReportBody>({
          method: 'GET',
          path: `${REPORTS_PATH}${reportQuery(from, to)}`,
        }),
      ]);
      setPayouts(p);
      setReport(r);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Failed to load.'));
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = () =>
    downloadCsv(`${REPORTS_PATH}${reportQuery(from, to)}`, 'holdfast-statements.csv').catch(
      (err: Error) => toast.show({ title: err.message, tone: 'error' }),
    );

  const totals = report?.totals;
  const loaded = payouts && report;
  const empty = loaded && payouts.payouts.length === 0 && report.statements.length === 0;

  return (
    <div className="flex flex-col lg:flex-row lg:gap-8">
      <div className="min-w-0 flex-1">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <PageHeader eyebrow={me.brand.name} title="Payouts & reports" />
          <div className="flex flex-wrap items-end gap-3 pb-8 lg:pb-12">
            <DateField id={fromId} label="Cleared from" value={from} onChange={setFrom} />
            <DateField id={toId} label="to" value={to} onChange={setTo} />
            <Button variant="outline" onClick={() => void exportCsv()} disabled={!loaded}>
              Export CSV
            </Button>
          </div>
        </div>

        {error && !loaded ? (
          <ErrorBanner message={error.message} onRetry={() => void load()} />
        ) : !loaded ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
          </div>
        ) : empty && !from && !to ? (
          <EmptyState
            message="No payouts yet. Clear a listing; once its captures settle, your payout and statement appear here."
            action={
              <Link to={paths.brand} className="text-[14px] text-orange underline">
                Go to listings
              </Link>
            }
          />
        ) : (
          <>
            {error && (
              <ErrorBanner
                className="mb-4"
                message="Could not refresh."
                onRetry={() => void load()}
              />
            )}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatTile
                label="Gross captured"
                value={usd(totals?.grossRealCents)}
                caption={`${totals?.units ?? 0} units`}
              />
              <StatTile label="Holdfast fee" value={usd(totals?.feeCents)} />
              <StatTile label="Net to you" value={usd(totals?.netCents)} emphasis />
              <StatTile
                label="Paid out"
                value={usd(
                  payouts.payouts
                    .filter((p) => p.status === 'SUCCESS')
                    .reduce((s, p) => s + (p.netCents ?? 0), 0),
                )}
                caption={
                  totals && totals.grossSimulatedCents > 0
                    ? `Simulated ${usd(totals.grossSimulatedCents)} not paid out`
                    : undefined
                }
              />
            </div>

            <PayoutsTable body={payouts} />

            <section aria-labelledby="statements-h" className="mt-10">
              <h2 id="statements-h" className="label mb-3 text-[11px] text-muted">
                Statements
              </h2>
              {report.statements.length === 0 ? (
                <EmptyState message="No listings cleared in this range." />
              ) : (
                <ul className="flex flex-col gap-3">
                  {report.statements.map((s) => (
                    <li key={s.listingId}>
                      <StatementCard
                        s={s}
                        open={open === s.listingId}
                        onToggle={() => setOpen(open === s.listingId ? null : s.listingId)}
                        canShip={canShip}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function DateField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.id} className="label text-[11px] text-muted">
        {props.label}
      </label>
      <input
        id={props.id}
        type="date"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-9 rounded-sm border border-border bg-white px-2 text-[14px]"
      />
    </div>
  );
}

const th = 'label px-3 py-2 text-left text-[11px] font-normal text-muted';
const td = 'px-3 py-2 text-[14px] tabular-nums';

function PayoutsTable({ body }: { body: BrandPayoutsBody }) {
  return (
    <section aria-labelledby="payouts-h" className="mt-10">
      <h2 id="payouts-h" className="label mb-3 text-[11px] text-muted">
        Payouts
      </h2>
      {body.payouts.length === 0 ? (
        <EmptyState message="No payout has been sent yet." />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-white">
          <table className="w-full min-w-[640px]">
            <thead className="border-b border-line">
              <tr>
                <th className={th}>Listing</th>
                <th className={th}>Status</th>
                <th className={cn(th, 'text-right')}>Gross</th>
                <th className={cn(th, 'text-right')}>Fee</th>
                <th className={cn(th, 'text-right')}>Net</th>
                <th className={th}>Sent</th>
              </tr>
            </thead>
            <tbody>
              {body.payouts.map((p) => {
                const badge = payoutBadge(p);
                return (
                  <tr key={p.payoutId} className="border-b border-line last:border-0">
                    <td className={td}>
                      <Link
                        to={paths.listingSettlement(p.listingId)}
                        className="text-ink hover:underline"
                      >
                        {p.productTitle}
                      </Link>
                      {p.attempt > 1 && (
                        <span className="ml-2 text-[12px] text-muted">attempt {p.attempt}</span>
                      )}
                    </td>
                    <td className={td}>
                      <Badge tone={badge.tone} title={p.failureReason ?? undefined}>
                        {badge.label}
                      </Badge>
                    </td>
                    <td className={cn(td, 'text-right')}>{usd(p.grossCents)}</td>
                    <td className={cn(td, 'text-right')}>{usd(p.feeCents)}</td>
                    <td className={cn(td, 'text-right text-ink')}>{usd(p.netCents)}</td>
                    <td className={cn(td, 'text-body')}>
                      {formatWhen(p.completedAt ?? p.sentAt ?? p.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatementCard(props: {
  s: ListingStatement;
  open: boolean;
  onToggle: () => void;
  canShip: boolean;
}) {
  const { s } = props;
  const pb = s.payoutStatus ? payoutBadge({ status: s.payoutStatus, itemStatus: null }) : null;
  return (
    <div className="rounded-md border border-line bg-white">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:bg-surface"
      >
        <span className="flex flex-col gap-1">
          <span className="text-[16px] font-medium text-ink">{s.productTitle}</span>
          <span className="text-[13px] text-muted">
            Cleared {s.clearedAt ? formatWhen(s.clearedAt) : '—'} · {s.units} units
          </span>
        </span>
        <span className="flex items-center gap-3">
          {pb && <Badge tone={pb.tone}>{pb.label}</Badge>}
          <span className="text-[16px] text-ink tabular-nums">{usd(s.netCents)} net</span>
          <span className="text-[13px] text-orange">{props.open ? 'Close' : 'Open statement'}</span>
        </span>
      </button>
      {props.open && (
        <div className="border-t border-line p-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Fact label="Gross (captured)" value={usd(s.grossRealCents)} />
            <Fact label={`Fee (${(s.feeBps / 100).toFixed(2)}%)`} value={usd(s.feeCents)} />
            <Fact label="Net" value={usd(s.netCents)} />
            <Fact label="Units captured" value={String(s.units)} />
            <Fact label="Cutoff (lowest winning bid)" value={usd(s.cutoffCents)} />
            <Fact label="Average price" value={usd(s.averageCents)} />
            {s.grossSimulatedCents > 0 && (
              <Fact
                label="Simulated (not paid out)"
                value={`${usd(s.grossSimulatedCents)} · ${s.unitsSimulated} units`}
              />
            )}
          </dl>
          <p className="mt-3 text-[13px] text-muted">
            Each winner paid their own bid. Gross is the sum of completed PayPal captures.
          </p>
          <OrderTimeline
            path={`/api/listings/${encodeURIComponent(s.listingId)}/timeline`}
            className="mt-6"
          />
          <TrackingPanel listingId={s.listingId} canShip={props.canShip} />
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="label text-[11px] text-muted">{label}</dt>
      <dd className="text-[15px] text-ink tabular-nums">{value}</dd>
    </div>
  );
}

function TrackingPanel({ listingId, canShip }: { listingId: string; canShip: boolean }) {
  const [roster, setRoster] = useState<ShipmentRosterBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setRoster(
        await api.request<ShipmentRosterBody>({ method: 'GET', path: shipmentsPath(listingId) }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load winners.');
    }
  }, [listingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const template = () =>
    downloadCsv(shipmentsPath(listingId), 'holdfast-shipments.csv').catch((err: Error) =>
      toast.show({ title: err.message, tone: 'error' }),
    );

  return (
    <section aria-label="Shipment tracking" className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="label text-[11px] text-muted">Tracking</h3>
        <Button variant="ghost" onClick={() => void template()}>
          Download CSV template
        </Button>
      </div>
      {error && <ErrorBanner message={error} onRetry={() => void load()} />}
      {!roster ? (
        <Skeleton className="h-24" />
      ) : roster.rows.length === 0 ? (
        <EmptyState message="No charged winners on this listing yet." />
      ) : (
        <>
          {canShip && <UploadZone listingId={listingId} onDone={load} />}
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {roster.rows.map((r) => (
              <RosterRow
                key={r.bidId}
                listingId={listingId}
                row={r}
                canShip={canShip}
                onDone={load}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RosterRow(props: {
  listingId: string;
  row: ShipmentRosterRow;
  canShip: boolean;
  onDone: () => Promise<void>;
}) {
  const { row } = props;
  const [carrier, setCarrier] = useState(row.shipment?.carrier ?? 'UPS');
  const [number, setNumber] = useState(row.shipment?.trackingNumber ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = useRef(new ApiAction(api));
  const badge = shipmentBadge(row);
  const editable = props.canShip && canEnterTracking(row);
  const carrierId = useId();
  const numberId = useId();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await action.current.run<ShipmentResponseBody>({
        method: 'POST',
        path: shipmentsPath(props.listingId),
        body: { bidId: row.bidId, carrier: carrier.trim(), trackingNumber: number.trim() },
      });
      action.current.reset();
      await props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save tracking.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <span className="text-[14px] text-ink">{row.winnerLabel}</span>
        <span className="text-[13px] text-muted tabular-nums">{usd(row.amountCents)}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {editable ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor={carrierId} className="sr-only">
            Carrier
          </label>
          <input
            id={carrierId}
            list="hf-carriers"
            value={carrier}
            onChange={(e) => setCarrier(e.target.value)}
            className="h-9 w-28 rounded-sm border border-border bg-white px-2 text-[14px]"
          />
          <label htmlFor={numberId} className="sr-only">
            Tracking number
          </label>
          <input
            id={numberId}
            value={number}
            placeholder="Tracking number"
            onChange={(e) => setNumber(e.target.value)}
            className="h-9 w-48 rounded-sm border border-border bg-white px-2 font-mono text-[13px]"
          />
          <Button type="submit" disabled={busy || !number.trim() || !carrier.trim()}>
            {busy ? 'Sending…' : 'Add tracking'}
          </Button>
          <datalist id="hf-carriers">
            {['UPS', 'USPS', 'FedEx', 'DHL', 'OnTrac', 'Amazon', 'Canada Post', 'Royal Mail'].map(
              (c) => (
                <option key={c} value={c} />
              ),
            )}
          </datalist>
          {error && (
            <p role="alert" className="w-full text-[13px] text-danger">
              {error}
            </p>
          )}
        </form>
      ) : row.shipment?.trackingNumber ? (
        <span className="font-mono text-[13px] text-body">
          {row.shipment.carrier} · {row.shipment.trackingNumber}
        </span>
      ) : null}
    </li>
  );
}

function UploadZone({ listingId, onDone }: { listingId: string; onDone: () => Promise<void> }) {
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const [over, setOver] = useState(false);
  const inputId = useId();

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setState(validateUpload(file.name, await file.text()));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void readFile(e.dataTransfer.files[0]);
  };

  const send = async () => {
    if (state.kind !== 'validating') return;
    const { fileName, csv } = state;
    setState({ kind: 'uploading', fileName });
    try {
      // A fresh action per upload; re-uploading a file is safe (tracked rows replay).
      const result = await new ApiAction(api).run<ShipmentUploadBody>({
        method: 'POST',
        path: `${shipmentsPath(listingId)}/csv`,
        body: { csv },
      });
      setState({ kind: 'done', fileName, result });
      await onDone();
    } catch (err) {
      setState({
        kind: 'failed',
        fileName,
        message: err instanceof ApiError ? err.message : 'Upload failed.',
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-start gap-1 rounded-md border border-dashed p-4',
          over ? 'border-orange bg-orange-tint' : 'border-planned bg-surface',
        )}
      >
        <span className="text-[14px] text-ink">Drop a tracking CSV, or choose a file</span>
        <span className="text-[13px] text-muted">
          Columns: bidId, carrier, trackingNumber (use the template). Tracking goes to PayPal and
          shows on each winner&apos;s order page.
        </span>
        <input
          id={inputId}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>

      {state.kind === 'validating' && (
        <div role="status" className="flex flex-col gap-2 rounded-md border border-line p-3">
          <p className="text-[14px] text-ink">
            {state.fileName}: {state.rows} {state.rows === 1 ? 'row' : 'rows'} ready
            {state.errors.length ? `, ${state.errors.length} with problems` : ''}.
          </p>
          <RowErrors
            errors={state.errors.map((e) => ({ row: e.row, bidId: e.bidId, message: e.message }))}
          />
          <div className="flex gap-2">
            <Button onClick={() => void send()} disabled={state.rows === 0}>
              Send {state.rows} to PayPal
            </Button>
            <Button variant="ghost" onClick={() => setState({ kind: 'idle' })}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {state.kind === 'uploading' && (
        <p role="status" className="text-[14px] text-body">
          Sending {state.fileName} to PayPal…
        </p>
      )}
      {state.kind === 'failed' && (
        <ErrorBanner message={state.message} onRetry={() => setState({ kind: 'idle' })} />
      )}
      {state.kind === 'done' && <UploadResult result={state.result} />}
    </div>
  );
}

function UploadResult({ result }: { result: ShipmentUploadBody }) {
  const summary = uploadSummary(result);
  const failed = result.results.filter((r) => !r.ok);
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3',
        summary.tone === 'success' ? 'border-success/30' : 'border-danger/30 bg-danger-tint',
      )}
    >
      <p className="text-[14px] text-ink">{summary.text}</p>
      <RowErrors
        errors={failed.map((r) => ({
          row: r.row,
          bidId: r.bidId,
          message: r.ok ? '' : r.error.message,
        }))}
      />
    </div>
  );
}

function RowErrors({
  errors,
}: {
  errors: { row: number; bidId: string | null; message: string }[];
}) {
  if (errors.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-[13px] text-danger">
      {errors.map((e) => (
        <li key={`${e.row}-${e.bidId ?? ''}`}>
          {e.row === 0 ? 'File' : `Row ${e.row}`}
          {e.bidId ? ` (${e.bidId.slice(0, 8)}…)` : ''}: {e.message}
        </li>
      ))}
    </ul>
  );
}
