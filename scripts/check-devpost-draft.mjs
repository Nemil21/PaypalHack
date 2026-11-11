#!/usr/bin/env node
// Lints the Devpost draft (HF-050a) against the submission requirements and our copy rules.
//
//   node scripts/check-devpost-draft.mjs            draft mode: open markers are reported, not errors
//   node scripts/check-devpost-draft.mjs --final    final submit (HF-050b): any open marker fails
//   node scripts/check-devpost-draft.mjs FILE       lint another file (e.g. text copied back from Devpost)
//
// Only the text between <!-- paste:start --> and <!-- paste:end --> is what judges see, so only that is linted.
// Values from .env are compared against the draft but never printed.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const final = args.includes('--final');
const file = resolve(args.find((a) => !a.startsWith('--')) ?? resolve(root, 'docs/devpost/DRAFT.md'));

const source = readFileSync(file, 'utf8');
const blocks = [...source.matchAll(/<!-- paste:start -->\n([\s\S]*?)<!-- paste:end -->/g)].map((m) => m[1]);
const text = blocks.length ? blocks.join('\n') : source;

const errors = [];
const notes = [];
const fail = (msg) => errors.push(msg);

// Devpost limits and required content (submission requirements 1, 3, 6).
if (blocks.length) {
  const pitch = source.match(/## Elevator pitch[^\n]*\n\n<!-- paste:start -->\n([\s\S]*?)<!-- paste:end -->/);
  if (!pitch) fail('missing the "Elevator pitch" paste block');
  else if (pitch[1].trim().length > 200) fail(`elevator pitch is ${pitch[1].trim().length} chars (Devpost limit 200)`);
  else notes.push(`elevator pitch: ${pitch[1].trim().length}/200 chars`);
}
const requiredHeadings = [
  'Inspiration',
  'What it does',
  'How we built it',
  'Testing access',
  "What's real and what's simulated",
  'Honest limits',
];
for (const h of requiredHeadings) {
  if (!new RegExp(`^## ${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text)) fail(`missing section "## ${h}"`);
}
const requiredTerms = {
  'PayPal AUTHORIZE holds': /AUTHORIZE/,
  'PayPal capture': /capture/i,
  'PayPal void': /void/i,
  'PayPal Payouts': /Payouts?/,
  'AI model named (Claude)': /Claude/,
  'MCP server': /MCP/,
  'sandbox testing access': /sandbox buyer/i,
  'DEMO_MODE logins': /DEMO_MODE/,
  'SIM labelling': /\bSIM\b/,
};
for (const [label, re] of Object.entries(requiredTerms)) if (!re.test(text)) fail(`missing required content: ${label}`);

// D14: pay-your-bid copy only.
const uniformPrice = [
  /one fair price/i,
  /uniform(-| )price/i,
  /single clearing price/i,
  /everyone pays/i,
  /all winners pay/i,
  /pays? the cutoff/i,
  /charged \$219/i,
];
for (const re of uniformPrice) if (re.test(text)) fail(`uniform-price copy (D14): ${re}`);

// D15: fictional brand only; no real brands, retailers or competitors in the text.
const trademarks = [
  'Sony', 'Bose', 'Sennheiser', 'Apple', 'AirPods', 'Beats', 'JBL', 'Samsung', 'Patagonia', 'North Face',
  'Best Buy', 'Amazon', 'Walmart', 'Costco', 'eBay', 'Shopify', 'B-Stock', 'Greentoe', 'Priceline', 'WebHouse',
];
for (const tm of trademarks) if (new RegExp(`\\b${tm}\\b`, 'i').test(text)) fail(`third-party trademark (D15): ${tm}`);

// Secrets: nothing from .env, no PayPal/Anthropic-looking keys, no card numbers, no sandbox account emails.
const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    // Only compare values that could be secrets; short or generic values (e.g. "true", a port) would false-positive.
    if (value.length >= 12 && !/^https?:\/\/[^/]*(sandbox\.paypal\.com|localhost)/.test(value) && text.includes(value)) {
      fail(`draft contains the value of .env ${m[1]} (value not printed)`);
    }
  }
}
const secretShapes = {
  'Anthropic key': /sk-ant-[A-Za-z0-9_-]{10,}/,
  'PayPal client id/secret shape': /\b(A[A-Za-z0-9_-]{70,}|E[A-Za-z0-9_-]{70,})\b/,
  'card number': /\b(?:\d[ -]?){13,19}\b/,
  'sandbox account email': /@(personal|business)\.example\.com/i,
};
for (const [label, re] of Object.entries(secretShapes)) if (re.test(text)) fail(`possible secret in draft: ${label}`);

// Open markers: fine in a draft, fatal at final submit.
const verify = [...text.matchAll(/\[\[verify: ([^\]]+)\]\]/g)].map((m) => m[1]);
const fill = [...text.matchAll(/\[\[fill: ([^\]]+)\]\]/g)].map((m) => m[1]);
const open = `${verify.length} [[verify]] and ${fill.length} [[fill]] markers open`;
if (final && (verify.length || fill.length)) fail(`${open}; resolve them before submitting`);
else notes.push(open);
if (verify.length) notes.push(`tickets to verify: ${[...new Set(verify.flatMap((v) => v.split(/,\s*/)))].sort().join(', ')}`);

for (const n of notes) console.log(`note: ${n}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL: ${e}`);
  process.exit(1);
}
console.log(`OK: ${file.replace(`${root}/`, '')} passes the ${final ? 'final' : 'draft'} checks`);
