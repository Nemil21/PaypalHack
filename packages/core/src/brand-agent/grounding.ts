/**
 * "Answers quote numbers only from tool JSON" (HF-051b; features/09 §Edge cases). After a turn,
 * every number in the model's text is checked against the JSON its tools returned. A number that
 * matches nothing is reported back (`unverifiedNumbers`), and the panel tells the brand to trust
 * the cards, which render from the JSON fields only. The text itself is commentary.
 *
 * Matching rules:
 * - `$219`, `$54,200`, `$54.2k`: dollars; matches any `*Cents` field within the shown precision.
 * - `10%`: matches a `*Bps` field as a percentage, or any plain number.
 * - `×5.8` / `5.8x`: matches a plain number (the recovery multiple) within the shown precision.
 * - Bare numbers: match a plain number (quantities, counts, digits inside dates) or a dollar
 *   amount. Bare numbers up to 10 are ignored ("top 3", "2 alternatives").
 */

interface Grounded {
  dollars: number[];
  plain: number[];
  percents: number[];
}

function collect(value: unknown, key: string, into: Grounded): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (/cents$/i.test(key)) into.dollars.push(value / 100);
    else if (/bps$/i.test(key)) {
      into.percents.push(value / 100);
      into.plain.push(value);
    } else into.plain.push(value);
    return;
  }
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\d+/g)) into.plain.push(Number(m[0]));
    return;
  }
  if (Array.isArray(value)) {
    // Arrays inherit their key: `alternatives: [...]` items carry their own keys anyway.
    for (const v of value) collect(v, key, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collect(v, k, into);
  }
}

const TOKEN =
  /(×\s*)?(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(k|K|m|M|thousand|million)?\b(\s?%|\s?[x×](?![a-z]))?/g;

const near = (list: number[], v: number, unit: number) =>
  list.some((g) => Math.abs(g - v) <= unit / 2 + 1e-9);

/** The numbers in `text` that match no number in `results`. */
export function ungroundedNumbers(text: string, results: unknown[]): string[] {
  const g: Grounded = { dollars: [], plain: [], percents: [] };
  for (const r of results) collect(r, '', g);

  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const [raw, times, dollar, whole, decimals, suffix, tail] = m;
    // Part of an identifier or a longer token (e.g. "A7", "v3"): not a quoted figure.
    const before = text[m.index! - 1];
    if (!times && !dollar && before && /[A-Za-z_-]/.test(before)) continue;
    const decimalsLen = decimals?.length ?? 0;
    const base = Number(`${whole!.replace(/,/g, '')}${decimals ? `.${decimals}` : ''}`);
    const mult = suffix ? (/^(k|thousand)$/i.test(suffix) ? 1_000 : 1_000_000) : 1;
    const value = base * mult;
    const unit = 10 ** -decimalsLen * mult;
    const percent = tail?.trim() === '%';
    const multiple = !!times || (!!tail && !percent);

    let ok: boolean;
    if (dollar || suffix) ok = near(g.dollars, value, unit);
    else if (percent) ok = near(g.percents, value, unit) || near(g.plain, value, unit);
    else if (multiple) ok = near(g.plain, value, unit);
    else if (decimalsLen === 0 && value <= 10) continue;
    else ok = near(g.plain, value, unit) || near(g.dollars, value, unit);

    if (!ok) out.push(raw.trim());
  }
  return [...new Set(out)];
}
