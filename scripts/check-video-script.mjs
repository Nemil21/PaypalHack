#!/usr/bin/env node
// Lints the demo video script (HF-050b) against the ticket's shot list and our copy rules.
//
//   node scripts/check-video-script.mjs          lint docs/devpost/VIDEO.md
//   node scripts/check-video-script.mjs FILE     lint another file
//
// Checks: beats numbered in order, back to back from 0:00 and ending under 3:00; the shot-list
// table agrees with the narration headings; the ticket's eight beats are all there; each beat's
// narration fits its slot at voiceover pace; the voiceover states what is SIM, what is a real
// sandbox hold, the replay and the time-lapse; the evidence shots are listed; D14 and D15.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trademarksIn, uniformPriceIn } from './lib/copy-rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? resolve(root, 'docs/devpost/VIDEO.md'));
const source = readFileSync(file, 'utf8');

/** Must end strictly before 3:00 (Devpost: "less than three minutes"). */
const LIMIT_SECONDS = 180;
/** Fail a beat whose narration would overrun its slot at this pace (a calm voiceover is ~150). */
const MAX_WPM = 156;
/** The ticket's shot list, in order: a pattern each beat title must match. */
const REQUIRED_BEATS = [
  ['problem', /problem/i],
  ['buyer agent + hold', /buyer agent/i],
  ['Claude Desktop MCP', /MCP/],
  ['price drop', /price drop/i],
  ['live rounds', /live round/i],
  ['Clear + settlement', /clear/i],
  ['PayPal sandbox merchant view', /PayPal/],
  ['architecture/sponsors + honesty', /architecture|honesty/i],
];
const REQUIRED_LABELS = {
  'SIM bidders named': /\bSIM\b/,
  'real sandbox holds named': /real sandbox/i,
  'replayed price event labelled': /replay/i,
  'time-lapse labelled': /time-lapse/i,
};
const EVIDENCE = {
  'PayPal sandbox dashboard': /PayPal sandbox/i,
  'Render Workflows run view': /Render Workflows/i,
  'a Channel3 response': /Channel3/,
  'the AG Grid console': /AG Grid/,
};

const errors = [];
const notes = [];
const fail = (msg) => errors.push(msg);

const secs = (t) => {
  const [m, s] = t.split(':').map(Number);
  return m * 60 + s;
};
const words = (t) => t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

const beats = [
  ...source.matchAll(
    /^### Beat (\d+) · (\d+:\d{2})–(\d+:\d{2}) · ([^\n]+)\n+<!-- narration:start -->\n([\s\S]*?)<!-- narration:end -->/gm,
  ),
].map((m) => ({ n: Number(m[1]), start: secs(m[2]), end: secs(m[3]), span: `${m[2]}–${m[3]}`, title: m[4].trim(), text: m[5].trim() }));
const headings = [...source.matchAll(/^### Beat \d+/gm)].length;

if (!beats.length) fail('no "### Beat N · m:ss–m:ss · Title" headings with a narration block');
if (headings !== beats.length) fail(`${headings - beats.length} beat heading(s) without a narration:start/end block`);

let at = 0;
beats.forEach((b, i) => {
  if (b.n !== i + 1) fail(`beat ${b.n} is out of order (expected beat ${i + 1})`);
  if (b.start !== at) fail(`beat ${b.n} starts at ${b.span.split('–')[0]}, not where the previous beat ends`);
  if (b.end <= b.start) fail(`beat ${b.n} (${b.span}) has no length`);
  at = b.end;
  if (!b.text) {
    fail(`beat ${b.n} has no narration`);
    return;
  }
  const n = words(b.text);
  const max = Math.floor(((b.end - b.start) * MAX_WPM) / 60);
  if (n > max) fail(`beat ${b.n} "${b.title}": ${n} words won't fit ${b.end - b.start} s (max ${max} at ${MAX_WPM} wpm)`);
  else notes.push(`beat ${b.n} ${b.span} ${b.title}: ${n}/${max} words`);
});
if (beats.length && at >= LIMIT_SECONDS) fail(`the last beat ends at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}; the video must be under 3:00`);

let next = 0;
for (const [label, re] of REQUIRED_BEATS) {
  const found = beats.findIndex((b, i) => i >= next && re.test(b.title));
  if (found < 0) fail(`missing beat (or out of order): ${label}`);
  else next = found + 1;
}

// The shot list must agree with the narration headings.
const rows = [...source.matchAll(/^\| (\d+) \| (\d+:\d{2}–\d+:\d{2}) \|/gm)].map((m) => ({ n: Number(m[1]), span: m[2] }));
if (!rows.length) fail('no shot-list table rows ("| n | m:ss–m:ss | …")');
for (const b of beats) {
  const row = rows.find((r) => r.n === b.n);
  if (!row) fail(`beat ${b.n} is not in the shot list`);
  else if (row.span !== b.span) fail(`beat ${b.n}: shot list says ${row.span}, narration says ${b.span}`);
}
for (const r of rows) if (!beats.some((b) => b.n === r.n)) fail(`shot-list row ${r.n} has no narration`);

const narration = beats.map((b) => b.text).join('\n');
for (const [label, re] of Object.entries(REQUIRED_LABELS)) if (!re.test(narration)) fail(`narration never says it: ${label}`);

const evidence = source.match(/^### Evidence shots[^\n]*\n([\s\S]*?)(?=^#{2,3} )/m);
if (!evidence) fail('missing the "### Evidence shots" section');
else for (const [label, re] of Object.entries(EVIDENCE)) if (!re.test(evidence[1])) fail(`evidence shots miss ${label}`);

// D14 on what reaches the viewer (narration and shot list; the rules section quotes the banned
// phrases on purpose). D15 on the whole file: no section has a reason to name a real brand.
const onScreen = [narration, ...source.split('\n').filter((l) => l.startsWith('|'))].join('\n');
for (const re of uniformPriceIn(onScreen)) fail(`uniform-price copy (D14): ${re}`);
for (const tm of trademarksIn(source)) fail(`third-party trademark (D15): ${tm}`);

const total = beats.reduce((sum, b) => sum + words(b.text), 0);
notes.push(`${beats.length} beats, ends at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}, ${total} narration words`);
for (const n of notes) console.log(`note: ${n}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL: ${e}`);
  process.exit(1);
}
console.log(`OK: ${file.replace(`${root}/`, '')} passes the video script checks`);
