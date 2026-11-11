import { formatUsd, type BookResponse, type DemandCurvePoint } from '@holdfast/shared';
import { formatUsdCompact } from './kpis';

/**
 * The console demand curve (HF-024, features/08 §Layout 3), as plain data for AG Charts: x =
 * price, y = bids at or above it (step line) and held dollars at or above it (second series).
 * Built from `book.curve`, which the server computes with the shared `buildDemandCurve` over the
 * per-shopper deduped Clear input (D8: bids without a hold never appear), so 5k+ bid books cost
 * the browser one point per distinct price.
 */

export interface CurveDatum {
  priceCents: number;
  bidsAtOrAbove: number;
  heldAtOrAboveCents: number;
  /** Hover: "120 bids ≥ $229 · $27.5k held". */
  hover: string;
}

export type CurveMarkerKind = 'floor' | 'publicLow' | 'cutoff';

export interface CurveMarker {
  kind: CurveMarkerKind;
  priceCents: number;
  label: string;
}

export interface CurveModel {
  data: CurveDatum[];
  /** x-axis range that keeps every marker and point on screen; null with no data and no marker. */
  domain: { min: number; max: number } | null;
  /** Floor and public low; the cutoff marker is added live from the slider (`cutoffMarker`). */
  markers: CurveMarker[];
}

/** "120 bids ≥ $229 · $27.5k held". */
export function curveHover(p: DemandCurvePoint): string {
  const bids = `${p.bidsAtOrAbove.toLocaleString('en-US')} ${p.bidsAtOrAbove === 1 ? 'bid' : 'bids'}`;
  return `${bids} ≥ ${formatUsd(p.priceCents)} · ${formatUsdCompact(p.heldAtOrAboveCents)} held`;
}

export function buildCurveModel(book: BookResponse): CurveModel {
  const data = book.curve.map((p) => ({ ...p, hover: curveHover(p) }));
  const markers: CurveMarker[] = [
    // The floor is brand-only; this console is brand-only.
    {
      kind: 'floor',
      priceCents: book.listing.floorCents,
      label: `Floor ${formatUsd(book.listing.floorCents)}`,
    },
  ];
  const low = book.listing.priceWatch.bestPublicPriceCents;
  if (low !== null) {
    markers.push({ kind: 'publicLow', priceCents: low, label: `Public low ${formatUsd(low)}` });
  }
  return { data, domain: curveDomain(data, markers), markers };
}

/** The live projected-cutoff marker, from the slider's numbers; null when nobody would win. */
export function cutoffMarker(cutoffCents: number | null): CurveMarker | null {
  return cutoffCents === null
    ? null
    : { kind: 'cutoff', priceCents: cutoffCents, label: `Cutoff ${formatUsd(cutoffCents)}` };
}

/** Pad 4% each side (at least $1) so the end markers and points are not on the frame. */
export function curveDomain(
  data: readonly { priceCents: number }[],
  markers: readonly { priceCents: number }[],
): { min: number; max: number } | null {
  const xs = [...data.map((d) => d.priceCents), ...markers.map((m) => m.priceCents)];
  if (xs.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const pad = Math.max(100, Math.round((max - min) * 0.04));
  return { min: Math.max(0, min - pad), max: max + pad };
}
