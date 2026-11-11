import { cutoffMarker, type CurveMarker, type CurveModel } from './curve';

/**
 * M10's compact demand curve (HF-061, screens.md M10): the W06 curve model (`buildCurveModel`,
 * same x domain and floor / public-low markers) drawn as a small SVG step line, so the phone
 * never loads AG Charts. x = price, y = bids at or above it; the cutoff marker follows the
 * quantity the brand would clear.
 */

export interface CompactCurve {
  /** Step line (`d` attribute); empty with no data. */
  line: string;
  /** The same line closed down to the x axis, for the fill. */
  area: string;
  markers: (CurveMarker & { x: number })[];
  /** The tallest point (bids at the lowest price): the y axis label. */
  maxBids: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function compactCurve(
  model: CurveModel,
  cutoffCents: number | null,
  size: { width: number; height: number; pad?: number },
): CompactCurve {
  const { width, height } = size;
  const pad = size.pad ?? 4;
  const domain = model.domain;
  const maxBids = model.data.reduce((m, d) => Math.max(m, d.bidsAtOrAbove), 0);
  if (!domain || domain.max <= domain.min) return { line: '', area: '', markers: [], maxBids };

  const x = (cents: number) =>
    round(pad + ((cents - domain.min) / (domain.max - domain.min)) * (width - 2 * pad));
  const y = (bids: number) =>
    round(height - pad - (maxBids ? (bids / maxBids) * (height - 2 * pad) : 0));

  // bidsAtOrAbove(x) for x in (p[i-1], p[i]] is the count at p[i]: step at the start, as W06.
  const pts = model.data;
  let line = '';
  pts.forEach((p, i) => {
    if (i === 0) line = `M${x(p.priceCents)} ${y(p.bidsAtOrAbove)}`;
    else
      line += ` L${x(pts[i - 1]!.priceCents)} ${y(p.bidsAtOrAbove)} L${x(p.priceCents)} ${y(p.bidsAtOrAbove)}`;
  });
  const area = pts.length
    ? `${line} L${x(pts[pts.length - 1]!.priceCents)} ${y(0)} L${x(pts[0]!.priceCents)} ${y(0)} Z`
    : '';

  const cutoff = cutoffMarker(cutoffCents);
  const markers = (cutoff ? [...model.markers, cutoff] : model.markers).map((m) => ({
    ...m,
    x: x(Math.min(domain.max, Math.max(domain.min, m.priceCents))),
  }));
  return { line, area, markers, maxBids };
}
