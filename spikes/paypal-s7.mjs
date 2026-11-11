// Spike S7 (HF-063): every PayPal call on the demo path that S1–S4 did not prove.
// Usage: node spikes/paypal-s7.mjs <command>
//   serve     browser harness for steps 1–2 on http://localhost:8787 (card fields, wallet)
//   s3        replays: order create, authorize, void twice, capture twice
//   s4        vault: two MIT holds from one vault_id + one CIT hold (+ wallet vault_id if step 2 vaulted)
//   s5        PayPal-Mock-Response AUTHORIZATION_EXPIRED on capture
//   s6        300 holds over 5 test cards at concurrency 20
//   s7        capture ≥ $50k of step-6 holds, check balance, ≈ $50k payout, poll batch + item, void the rest
//   cleanup   GET every authorization this spike created; void any still CREATED; record final states
//   render    write the evidence tables into spikes/s7-results.md
// Same sandbox app and .env as spikes/paypal-spikes.mjs. Raw evidence goes to spikes/s7-evidence/ (git-ignored).
// Never prints the client secret, card numbers, the payout email or full vault ids.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const BASE = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
if (!BASE.includes('sandbox')) throw new Error('S7 runs against the sandbox only');
const PORT = 8787;
const ORIGIN = `http://localhost:${PORT}`;
const EVID = new URL('./s7-evidence/', import.meta.url);
const RESULTS = new URL('./s7-results.md', import.meta.url);
mkdirSync(EVID, { recursive: true });

// PayPal's published sandbox test cards (not real cards). Step 6 spreads holds over all five.
const CARDS = [
  { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'S7 Visa' },
  { number: '4012888888881881', expiry: '2030-11', security_code: '123', name: 'S7 Visa B' },
  { number: '5555555555554444', expiry: '2030-10', security_code: '123', name: 'S7 Mastercard' },
  { number: '371449635398431', expiry: '2030-09', security_code: '1234', name: 'S7 Amex' }, // 5105105105105100 is rejected: VALIDATION_ERROR Invalid card number (run 1),
  { number: '6011111111111117', expiry: '2030-08', security_code: '123', name: 'S7 Discover' },
];
const TEST_CARD = CARDS[0];
const MIT = { payment_initiator: 'MERCHANT', payment_type: 'UNSCHEDULED', usage: 'SUBSEQUENT' };
const CIT = { payment_initiator: 'CUSTOMER', payment_type: 'UNSCHEDULED', usage: 'SUBSEQUENT' };

// ---------- PayPal transport ----------
let token, tokenExp = 0;
async function auth() {
  if (token && Date.now() < tokenExp) return token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status}`);
  const j = await res.json();
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in - 300) * 1000;
  return token;
}

// Every call returns a compact record: never the raw body (it can echo card or payer data).
async function pp(method, path, { body, requestId, headers = {}, label } = {}) {
  await auth();
  const rid = method === 'GET' ? undefined : (requestId ?? randomUUID());
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(rid ? { 'PayPal-Request-Id': rid } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    return { label, method, path, requestId: rid, http: 0, error: e.message, ms: Date.now() - t0, json: {} };
  }
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return {
    label, method, path: path.split('?')[0], requestId: rid, http: res.status, ms: Date.now() - t0,
    bodyStatus: json.status ?? json.batch_header?.batch_status ?? json.transaction_status,
    name: json.name, issue: json.details?.[0]?.issue, description: json.details?.[0]?.description,
    debugId: json.debug_id ?? res.headers.get('paypal-debug-id'),
    json,
  };
}
const strip = ({ json, ...rec }) => rec; // what goes into evidence

const usd = (v) => ({ currency_code: 'USD', value: Number(v).toFixed(2) });
const authzOf = (j) => j?.purchase_units?.[0]?.payments?.authorizations?.[0];
const capOf = (j) => j?.purchase_units?.[0]?.payments?.captures?.[0];
const short = (s) => (s ? `${String(s).slice(0, 4)}…` : s);

// ---------- evidence + ledger ----------
const evFile = (step) => new URL(`${step}.json`, EVID);
const loadEv = (step) => (existsSync(evFile(step)) ? JSON.parse(readFileSync(evFile(step), 'utf8')) : []);
function saveAttempt(step, attempt) {
  const all = loadEv(step);
  all.push({ ranAt: new Date().toISOString(), ...attempt });
  writeFileSync(evFile(step), JSON.stringify(all, null, 2));
  return attempt;
}
const LEDGER = new URL('ledger.jsonl', EVID);
function track(entry) { appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
const ledger = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---------- money primitives (request ids per D5 / INV-4) ----------
// Order create: PayPal-Request-Id = bid id, invoice_id = bid id. Raw card → authorized at create (S1 pattern).
async function cardHold(step, { bidId = randomUUID(), amount = 229, card = { ...TEST_CARD }, label = 'order create (card)', headers } = {}) {
  const r = await pp('POST', '/v2/checkout/orders', {
    label, requestId: bidId, headers,
    body: { intent: 'AUTHORIZE', purchase_units: [{ invoice_id: bidId, amount: usd(amount), description: 'Holdfast S7 bid' }], payment_source: { card } },
  });
  const a = authzOf(r.json);
  r.orderId = r.json.id; r.authId = a?.id; r.authStatus = a?.status; r.bodyStatus = a?.status ?? r.bodyStatus;
  r.vault = r.json.payment_source?.card?.attributes?.vault ?? r.json.payment_source?.paypal?.attributes?.vault;
  if (a?.id) track({ step, bidId, orderId: r.orderId, authId: a.id, amount });
  return { ...r, bidId };
}
const capture = (authId, amount, requestId, headers) =>
  pp('POST', `/v2/payments/authorizations/${authId}/capture`, { label: 'capture', requestId, headers, body: { amount: usd(amount), final_capture: true } });
const voidAuth = (authId, requestId) => pp('POST', `/v2/payments/authorizations/${authId}/void`, { label: 'void', requestId });
const getAuth = (authId) => pp('GET', `/v2/payments/authorizations/${authId}`, { label: 'GET authorization' });
const getOrder = (orderId) => pp('GET', `/v2/checkout/orders/${orderId}`, { label: 'GET order' });

// ---------- step 3: replays ----------
async function s3() {
  const calls = [];
  const log = (r, note) => { calls.push({ ...strip(r), note }); return r; };

  // 3a: order create replay (same PayPal-Request-Id + invoice_id), then same invoice_id under a new request id.
  const bidA = randomUUID();
  const a1 = log(await cardHold('s3', { bidId: bidA, label: 'order create #1' }), 'first create');
  const a2 = await cardHold('s3', { bidId: bidA, label: 'order create #2 same id' });
  log(a2, `replay → same order: ${a1.orderId === a2.orderId}, same auth: ${a1.authId === a2.authId}`);
  const aDup = await pp('POST', '/v2/checkout/orders', {
    label: 'order create, same invoice_id, new request id', requestId: randomUUID(),
    body: { intent: 'AUTHORIZE', purchase_units: [{ invoice_id: bidA, amount: usd(229) }], payment_source: { card: { ...TEST_CARD } } },
  });
  const aDupAuth = authzOf(aDup.json);
  if (aDupAuth) track({ step: 's3', bidId: `${bidA}-dup`, orderId: aDup.json.id, authId: aDupAuth.id, amount: 229 });
  log({ ...aDup, bodyStatus: aDupAuth?.status ?? aDup.bodyStatus }, aDupAuth ? `new order ${aDup.json.id} (invoice_id not deduped at create)` : 'rejected');

  // 3b: authorize replay. Order created with no payment_source; authorize supplies the card.
  const bidB = randomUUID();
  const ob = log(await pp('POST', '/v2/checkout/orders', {
    label: 'order create (no source)', requestId: bidB,
    body: { intent: 'AUTHORIZE', purchase_units: [{ invoice_id: bidB, amount: usd(229) }] },
  }), 'order for authorize replay');
  const authzBody = { payment_source: { card: { ...TEST_CARD } } };
  const b1 = log(await pp('POST', `/v2/checkout/orders/${ob.json.id}/authorize`, { label: 'authorize #1', requestId: `authz-${bidB}`, body: authzBody }));
  const b1a = authzOf(b1.json);
  if (b1a) track({ step: 's3', bidId: bidB, orderId: ob.json.id, authId: b1a.id, amount: 229 });
  const b2 = await pp('POST', `/v2/checkout/orders/${ob.json.id}/authorize`, { label: 'authorize #2 same id', requestId: `authz-${bidB}`, body: authzBody });
  log({ ...b2, bodyStatus: b2.bodyStatus }, `same auth id: ${authzOf(b2.json)?.id === b1a?.id}`);
  const b3 = await pp('POST', `/v2/checkout/orders/${ob.json.id}/authorize`, { label: 'authorize #3 new id', requestId: `authz-${bidB}-2`, body: authzBody });
  const b3a = authzOf(b3.json);
  if (b3a && b3a.id !== b1a?.id) track({ step: 's3', bidId: `${bidB}-2`, orderId: ob.json.id, authId: b3a.id, amount: 229 });
  log(b3, b3a ? `auth ${b3a.id === b1a?.id ? 'same' : 'DIFFERENT'}` : 'rejected');
  const bg = await getOrder(ob.json.id);
  log(bg, `order ${bg.bodyStatus}, authorizations: ${bg.json.purchase_units?.[0]?.payments?.authorizations?.length ?? 0}`);

  // 3c: void twice with the same id, and twice with different ids.
  const v1 = log(await voidAuth(a1.authId, `void-${bidA}`), 'void #1');
  const v2 = log(await voidAuth(a1.authId, `void-${bidA}`), 'void #2 same id');
  const hv = await cardHold('s3', { label: 'order create (void-diff hold)' });
  log(hv);
  log(await voidAuth(hv.authId, `void-${hv.bidId}`), 'void #1');
  log(await voidAuth(hv.authId, `void-${hv.bidId}-retry`), 'void #2 different id');
  log(await getAuth(hv.authId), 'state after double void');

  // 3d: capture twice with the same id, and twice with different ids.
  const hc = await cardHold('s3', { label: 'order create (capture-same hold)' }); log(hc);
  const sid = randomUUID();
  const c1 = log(await capture(hc.authId, 229, sid), 'capture #1');
  const c2 = log(await capture(hc.authId, 229, sid), 'capture #2 same id');
  calls.at(-1).note += ` → same capture id: ${c1.json.id && c1.json.id === c2.json.id}`;
  const hd = await cardHold('s3', { label: 'order create (capture-diff hold)' }); log(hd);
  const d1 = log(await capture(hd.authId, 229, randomUUID()), 'capture #1');
  log(await capture(hd.authId, 229, randomUUID()), 'capture #2 different id');
  const dg = log(await getAuth(hd.authId), 'state after double capture');
  calls.at(-1).note += `: ${dg.bodyStatus}, capture link present: ${!!dg.json.links?.find((l) => l.href.includes('/captures/'))}`;

  // 3e: cross cases for RECONCILE: capture a voided auth, void a captured auth.
  log(await capture(a1.authId, 229, randomUUID()), 'capture after void');
  log(await voidAuth(hd.authId, `void-${hd.bidId}`), 'void after capture');
  log(await getAuth(a1.authId), 'state of voided auth');

  // leftover holds from 3a dup / 3b
  for (const id of [aDupAuth?.id, b1a?.id, b3a?.id].filter(Boolean)) log(await voidAuth(id, `void-cleanup-${id}`), 'cleanup void');

  const pass = a1.orderId === a2.orderId && v1.http < 300 && c1.json.status === 'COMPLETED';
  return saveAttempt('s3', { pass, calls, summary: { orderReplaySame: a1.orderId === a2.orderId, captureReplaySame: c1.json.id === c2.json.id, voidReplayHttp: v2.http } });
}

// Step 3 follow-up: which order-create replays come back as a replay rather than 422 TRANSACTION_REFUSED?
async function s3x() {
  const calls = [];
  const log = (r, note) => { calls.push({ ...strip(r), note }); return r; };
  const create = (label, rid, pu, source) => pp('POST', '/v2/checkout/orders', {
    label, requestId: rid, body: { intent: 'AUTHORIZE', purchase_units: [{ amount: usd(229), ...pu }], ...(source ? { payment_source: source } : {}) },
  });
  const pair = async (name, pu, source, gapMs = 0) => {
    const rid = randomUUID();
    const r1 = await create(`${name} #1`, rid, pu(rid), source);
    if (gapMs) await new Promise((ok) => setTimeout(ok, gapMs));
    const r2 = await create(`${name} #2 same id${gapMs ? ` after ${gapMs / 1000}s` : ''}`, rid, pu(rid), source);
    for (const r of [r1, r2]) { const a = authzOf(r.json); if (a) track({ step: 's3', bidId: rid, orderId: r.json.id, authId: a.id, amount: 229 }); r.bodyStatus = a?.status ?? r.bodyStatus; }
    log(r1); log(r2, `same order id: ${!!r1.json.id && r1.json.id === r2.json.id}`);
    return r1.json.id && r1.json.id === r2.json.id;
  };
  const card = { card: { ...TEST_CARD } };
  const out = {
    noSourceWithInvoice: await pair('no source, invoice_id', (rid) => ({ invoice_id: rid }), null),
    cardNoInvoice: await pair('raw card, no invoice_id', () => ({}), card),
    cardWithInvoice: await pair('raw card, invoice_id', (rid) => ({ invoice_id: rid }), card),
    cardWithInvoiceGap: await pair('raw card, invoice_id', (rid) => ({ invoice_id: rid }), card, 5000),
  };
  return saveAttempt('s3x', { pass: true, calls, summary: { sameOrderOnReplay: out } });
}

// ---------- step 4: vault MIT ×2 + CIT ----------
async function s4() {
  const calls = [];
  const log = (r, note) => { calls.push({ ...strip(r), note, vault: r.vault ? { status: r.vault.status, id: short(r.vault.id) } : undefined }); return r; };
  const fromCardFields = loadEv('s1').filter((a) => a.vaultId).at(-1)?.vaultId;
  let vaultId = fromCardFields, source = 'card-fields (step 1)';
  const holds = [];
  if (!vaultId) {
    const first = log(await cardHold('s4', { card: { ...TEST_CARD, attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } }, label: 'order create + vault' }));
    holds.push(first); vaultId = first.vault?.id; source = 'server-side raw card';
  }
  if (!vaultId) return saveAttempt('s4', { pass: false, calls, summary: { error: 'no vault id' } });
  const m1 = log(await cardHold('s4', { amount: 199, card: { vault_id: vaultId, stored_credential: MIT }, label: 'MIT hold #1' }));
  const m1r = await cardHold('s4', { bidId: m1.bidId, amount: 199, card: { vault_id: vaultId, stored_credential: MIT }, label: 'MIT hold #1 replay same id' });
  log(m1r, `same order id: ${!!m1.orderId && m1.orderId === m1r.orderId}`);
  if (m1r.authId && m1r.authId !== m1.authId) holds.push(m1r);
  const m2 = log(await cardHold('s4', { amount: 209, card: { vault_id: vaultId, stored_credential: MIT }, label: 'MIT hold #2 same vault' }));
  const c = log(await cardHold('s4', { amount: 219, card: { vault_id: vaultId, stored_credential: CIT }, label: 'CIT hold (payment_initiator CUSTOMER)' }));
  holds.push(m1, m2, c);

  // Wallet vault from step 2, if it vaulted: can we hold again with no buyer present?
  const walletVault = loadEv('s2').filter((a) => a.vaultId).at(-1)?.vaultId;
  let w;
  if (walletVault) {
    const bidId = randomUUID();
    w = await pp('POST', '/v2/checkout/orders', {
      label: 'wallet MIT hold (paypal.vault_id)', requestId: bidId,
      body: { intent: 'AUTHORIZE', purchase_units: [{ invoice_id: bidId, amount: usd(189) }], payment_source: { paypal: { vault_id: walletVault } } },
    });
    const wa = authzOf(w.json);
    if (wa) track({ step: 's4', bidId, orderId: w.json.id, authId: wa.id, amount: 189 });
    w.authId = wa?.id; w.bodyStatus = wa?.status ?? w.bodyStatus;
    log(w, wa ? 'authorized at create, no buyer' : `order ${w.json.status ?? ''}`);
    holds.push(w);
  }
  for (const h of holds.filter((x) => x.authId)) log(await voidAuth(h.authId, `void-${h.bidId ?? h.requestId}`), 'cleanup void');
  const ok = (h) => h.authStatus === 'CREATED' || h.bodyStatus === 'CREATED';
  return saveAttempt('s4', {
    pass: ok(m1) && ok(m2) && ok(c),
    calls,
    summary: { vaultSource: source, mit1: m1.bodyStatus, mit2: m2.bodyStatus, cit: c.bodyStatus, walletMit: w ? w.bodyStatus ?? w.issue : 'not run (no wallet vault)' },
  });
}

// ---------- step 5: mock AUTHORIZATION_EXPIRED ----------
async function s5() {
  const calls = [];
  const log = (r, note) => { calls.push({ ...strip(r), note }); return r; };
  const h = log(await cardHold('s5', { label: 'order create' }));
  const mock = { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: 'AUTHORIZATION_EXPIRED' }) };
  const c = log(await capture(h.authId, 229, randomUUID(), mock), 'capture with mock AUTHORIZATION_EXPIRED');
  const g = log(await getAuth(h.authId), 'real state after mocked capture');
  // control: the mock that S3 proved, for comparison of shape
  const h2 = log(await cardHold('s5', { label: 'order create (control)' }));
  log(await capture(h2.authId, 229, randomUUID(), { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' }) }), 'control: mock INSTRUMENT_DECLINED');
  for (const x of [h, h2]) log(await voidAuth(x.authId, `void-${x.bidId}`), 'cleanup void');
  return saveAttempt('s5', { pass: c.issue === 'AUTHORIZATION_EXPIRED', calls, summary: { captureHttp: c.http, issue: c.issue, realStateAfter: g.bodyStatus } });
}

// ---------- step 6: 300 holds over 5 cards, concurrency 20 ----------
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1) };
};
async function s6(n = 300, conc = 20) {
  const t0 = Date.now();
  const holds = await pool(Array.from({ length: n }, (_, i) => i), conc, async (i) => {
    let r = await cardHold('s6', { card: { ...CARDS[i % CARDS.length] } });
    let retried = false;
    if (!r.authId && (r.http === 429 || r.http >= 500 || r.http === 0)) { // one same-id retry, as the client will do
      retried = true; await new Promise((ok) => setTimeout(ok, 1000));
      r = await cardHold('s6', { bidId: r.bidId, card: { ...CARDS[i % CARDS.length] } });
    }
    return { i, card: i % CARDS.length, bidId: r.bidId, orderId: r.orderId, authId: r.authId, status: r.authStatus ?? r.bodyStatus, http: r.http, issue: r.issue ?? r.name, debugId: r.debugId, ms: r.ms, retried, requestId: r.requestId };
  });
  const wall = Date.now() - t0;
  const byStatus = {}; holds.forEach((h) => { byStatus[h.status ?? `HTTP ${h.http}`] = (byStatus[h.status ?? `HTTP ${h.http}`] ?? 0) + 1; });
  const perCard = CARDS.map((c, k) => ({ card: c.name, ok: holds.filter((h) => h.card === k && h.status === 'CREATED').length, total: holds.filter((h) => h.card === k).length }));
  const failures = holds.filter((h) => h.status !== 'CREATED');
  return saveAttempt('s6', {
    pass: failures.length === 0,
    summary: { n, conc, wallMs: wall, latency: stats(holds.map((h) => h.ms)), byStatus, perCard, rateLimited: holds.filter((h) => h.http === 429).length, retried: holds.filter((h) => h.retried).length, failures: failures.map(({ i, http, issue, debugId, status }) => ({ i, http, issue, debugId, status })) },
    holds,
  });
}

// ---------- step 7: capture ≥ $50k, payout ≈ $50k, poll, void the rest ----------
async function balance() {
  const r = await pp('GET', '/v1/reporting/balances?currency_code=USD', { label: 'GET balances' });
  const b = r.json.balances?.find((x) => x.currency === 'USD');
  return { rec: strip(r), total: b ? Number(b.total_balance?.value) : null, available: b ? Number(b.available_balance?.value) : null };
}
async function s7({ captureN = 240, payoutValue = 50000, conc = 20 } = {}) {
  const calls = [];
  const s6run = loadEv('s6').at(-1);
  if (!s6run) throw new Error('run s6 first');
  const live = s6run.holds.filter((h) => h.authId && h.status === 'CREATED');
  const b0 = await balance(); calls.push({ ...b0.rec, note: `before: total ${b0.total}, available ${b0.available}` });

  const toCap = live.slice(0, captureN);
  const t0 = Date.now();
  const caps = await pool(toCap, conc, async (h) => {
    const sid = randomUUID();
    let r = await capture(h.authId, 229, sid);
    if (r.http === 429 || r.http >= 500 || r.http === 0) { await new Promise((ok) => setTimeout(ok, 1000)); r = await capture(h.authId, 229, sid); }
    return { authId: h.authId, bidId: h.bidId, settlementId: sid, http: r.http, status: r.bodyStatus, issue: r.issue, captureId: r.json.id, ms: r.ms, fee: Number(r.json.seller_receivable_breakdown?.paypal_fee?.value ?? 0), net: Number(r.json.seller_receivable_breakdown?.net_amount?.value ?? 0) };
  });
  const capMs = Date.now() - t0;
  const okCaps = caps.filter((c) => c.status === 'COMPLETED');
  const gross = okCaps.length * 229, net = okCaps.reduce((s, c) => s + c.net, 0), fees = okCaps.reduce((s, c) => s + c.fee, 0);
  const capStatus = {}; caps.forEach((c) => { capStatus[c.status ?? c.issue ?? `HTTP ${c.http}`] = (capStatus[c.status ?? c.issue ?? `HTTP ${c.http}`] ?? 0) + 1; });

  let b1 = await balance();
  for (let k = 0; k < 6 && b0.total != null && b1.total != null && b1.total - b0.total < net - 1; k++) {
    await new Promise((ok) => setTimeout(ok, 10000)); b1 = await balance();
  }
  calls.push({ ...b1.rec, note: `after captures: total ${b1.total}, available ${b1.available}, delta ${b1.total != null && b0.total != null ? (b1.total - b0.total).toFixed(2) : 'n/a'}` });

  // Pay out no more than the net captured in this run, so the payout is funded by these captures.
  const value = Math.min(payoutValue, Math.floor(net) - 100);
  const po = await payoutAndPoll(value, `Holdfast S7: ${okCaps.length} units cleared, each at the winner's own bid`, calls);
  const { batch, item, polls, batchId, attemptId, itemId } = po;
  const b2 = await balance(); calls.push({ ...b2.rec, note: `after payout: total ${b2.total}, available ${b2.available}` });

  // void the remaining step-6 holds
  const rest = live.slice(captureN);
  const voids = await pool(rest, conc, (h) => voidAuth(h.authId, `void-${h.bidId}`).then((r) => ({ authId: h.authId, http: r.http, issue: r.issue })));
  const voidOk = voids.filter((v) => v.http < 300).length;

  const itemStatus = item?.json.transaction_status;
  return saveAttempt('s7', {
    pass: batch?.bodyStatus === 'SUCCESS' && itemStatus === 'SUCCESS',
    calls,
    summary: {
      captured: okCaps.length, attempted: caps.length, capStatus, gross, fees: +fees.toFixed(2), net: +net.toFixed(2), captureWallMs: capMs, captureLatency: stats(caps.map((c) => c.ms)),
      balanceBefore: b0.total, balanceAfterCaptures: b1.total, balanceAfterPayout: b2.total,
      payout: { value, batchId, attemptId, batchStatus: batch?.bodyStatus, itemId, itemStatus, timeToTerminalMs: polls.at(-1)?.t, polls },
      voided: `${voidOk}/${rest.length}`,
    },
    caps,
  });
}

// Payout with sender_batch_id = a fresh attempt id (M4), then poll the batch and its item until terminal.
async function payoutAndPoll(value, note, calls, perItem = value) {
  const nItems = Math.ceil(value / perItem - 1e-9);
  const parts = Array.from({ length: nItems }, (_, k) => (k < nItems - 1 ? perItem : +(value - perItem * (nItems - 1)).toFixed(2)));
  const attemptId = randomUUID();
  const tp = Date.now();
  const p = await pp('POST', '/v1/payments/payouts', {
    label: 'POST payouts', requestId: attemptId,
    body: {
      sender_batch_header: { sender_batch_id: attemptId, email_subject: 'Holdfast payout (S7)', email_message: 'Cleared overstock window' },
      items: parts.map((v, k) => ({ recipient_type: 'EMAIL', amount: { value: v.toFixed(2), currency: 'USD' }, receiver: env.PAYPAL_BRAND_EMAIL, note, sender_item_id: `${attemptId}-${k + 1}` })),
    },
  });
  calls.push({ ...strip(p), note: `payout ${value.toFixed(2)} USD in ${parts.length} item(s), sender_batch_id = attempt id; batch ${p.json.batch_header?.batch_status ?? '–'}` });
  const batchId = p.json.batch_header?.payout_batch_id;
  const polls = [];
  let batch, item, itemId;
  const TERMINAL_BATCH = ['SUCCESS', 'DENIED', 'CANCELED'];
  const TERMINAL_ITEM = ['SUCCESS', 'FAILED', 'RETURNED', 'REFUNDED', 'REVERSED', 'BLOCKED', 'DENIED', 'UNCLAIMED', 'CANCELED'];
  for (let k = 0; batchId && k < 120; k++) {
    batch = await pp('GET', `/v1/payments/payouts/${batchId}`, { label: 'GET payout batch' });
    itemId = batch.json.items?.[0]?.payout_item_id ?? itemId;
    if (itemId) item = await pp('GET', `/v1/payments/payouts-item/${itemId}`, { label: 'GET payout item' });
    polls.push({ t: Date.now() - tp, batch: batch.bodyStatus, item: item?.json.transaction_status });
    if (TERMINAL_BATCH.includes(batch.bodyStatus) && TERMINAL_ITEM.includes(item?.json.transaction_status)) break;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  if (batch) calls.push({ ...strip(batch), note: `batch final: ${batch.bodyStatus}, amount ${batch.json.batch_header?.amount?.value}, fees ${batch.json.batch_header?.fees?.value}` });
  if (item) calls.push({ ...strip(item), bodyStatus: item.json.transaction_status, note: `item final: ${item.json.transaction_status}${item.json.errors ? ' ' + item.json.errors.name : ''}, payout_item_fee ${item.json.payout_item_fee?.value}` });
  return { http: p.http, issue: p.name, batch, item, polls, batchId, attemptId, itemId, ok: batch?.bodyStatus === 'SUCCESS' && item?.json.transaction_status === 'SUCCESS' };
}

// Retry the step-7 payout alone (new attempt id), e.g. after INSUFFICIENT_FUNDS.
async function payout(value = 50000, perItem) {
  const calls = [];
  const r = await payoutAndPoll(Number(value), 'Holdfast S7: 240 units cleared, each at the winner\'s own bid', calls, Number(perItem ?? value));
  return saveAttempt('s7-payout', {
    pass: r.ok, calls,
    summary: { value: Number(value), perItem: Number(perItem ?? value), batchId: r.batchId, attemptId: r.attemptId, batchStatus: r.batch?.bodyStatus, itemId: r.itemId, itemStatus: r.item?.json.transaction_status, timeToTerminalMs: r.polls.at(-1)?.t, polls: r.polls },
  });
}

// ---------- cleanup: nothing left CREATED ----------
async function cleanup() {
  const entries = [...new Map(ledger().map((e) => [e.authId, e])).values()];
  const pass1 = await pool(entries, 20, async (e) => ({ ...e, state: (await getAuth(e.authId)).bodyStatus }));
  const stillCreated = pass1.filter((e) => e.state === 'CREATED' || e.state === 'PENDING');
  const voids = await pool(stillCreated, 20, (e) => voidAuth(e.authId, `void-${e.bidId}`).then((r) => ({ authId: e.authId, http: r.http, issue: r.issue })));
  const pass2 = await pool(entries, 20, async (e) => ({ authId: e.authId, step: e.step, state: (await getAuth(e.authId)).bodyStatus }));
  const count = (xs) => xs.reduce((m, x) => ({ ...m, [x.state ?? 'unknown']: (m[x.state ?? 'unknown'] ?? 0) + 1 }), {});
  // Card-fields / wallet orders that never reached authorize are not holds; record their order state.
  const openOrders = [];
  for (const a of [...loadEv('s1'), ...loadEv('s2')]) {
    if (a.orderId && !a.authId) openOrders.push({ orderId: a.orderId, state: (await getOrder(a.orderId)).bodyStatus });
  }
  const leftCreated = pass2.filter((e) => e.state === 'CREATED').length;
  return saveAttempt('cleanup', { pass: leftCreated === 0, summary: { authorizations: entries.length, before: count(pass1), voidedNow: voids.length, voidResults: voids, after: count(pass2), leftCreated, openOrders } });
}

// ---------- steps 1–2: browser harness ----------
const cardBids = new Map(); // orderId → bidId
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
const readBody = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d ? JSON.parse(d) : {})); });

// Authorize (authz-<bidId>), replay it, read vault, then void: the HF-014b server half.
async function authorizeAndRecord(step, orderId, bidId, extra = {}) {
  const calls = [];
  const log = (r, note) => { calls.push({ ...strip(r), note }); return r; };
  const a1 = await pp('POST', `/v2/checkout/orders/${orderId}/authorize`, { label: 'authorize', requestId: `authz-${bidId}` });
  const az = authzOf(a1.json);
  const ps = a1.json.payment_source ?? {};
  const vault = ps.card?.attributes?.vault ?? ps.paypal?.attributes?.vault;
  a1.bodyStatus = az?.status ?? a1.bodyStatus;
  log(a1, `order ${a1.json.status ?? ''}; vault ${vault?.status ?? 'none'} ${short(vault?.id) ?? ''}; 3DS ${JSON.stringify(ps.card?.authentication_result?.liability_shift ?? 'n/a')}`);
  if (az) track({ step, bidId, orderId, authId: az.id, amount: Number(az.amount?.value) });
  const a2 = log(await pp('POST', `/v2/checkout/orders/${orderId}/authorize`, { label: 'authorize replay same id', requestId: `authz-${bidId}` }));
  calls.at(-1).note = `same auth id: ${authzOf(a2.json)?.id === az?.id}`;
  log(await pp('POST', `/v2/checkout/orders/${orderId}/authorize`, { label: 'authorize again new id', requestId: `authz-${bidId}-2` }));
  if (az) log(await voidAuth(az.id, `void-${bidId}`), 'void (spike cleanup; vault id kept)');
  const pass = az?.status === 'CREATED';
  saveAttempt(step, { pass, orderId, bidId, authId: az?.id, vaultId: vault?.id, vaultStatus: vault?.status ?? 'none', calls, ...extra });
  return { pass, authStatus: az?.status, vaultStatus: vault?.status ?? 'none', calls: calls.map(({ label, http, bodyStatus, issue, note }) => ({ label, http, bodyStatus, issue, note })) };
}

async function serve() {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, ORIGIN);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/s7-browser.html'))
        return send(res, 200, readFileSync(new URL('./s7-browser.html', import.meta.url)), 'text/html');
      if (url.pathname === '/api/client-id') return send(res, 200, { clientId: env.PAYPAL_CLIENT_ID }); // public id only

      // Step 1: card-fields order (no card data on our server; the browser submits it to PayPal).
      if (url.pathname === '/api/card/order') {
        const bidId = randomUUID();
        const r = await pp('POST', '/v2/checkout/orders', {
          label: 'order create (card fields)', requestId: bidId,
          body: {
            intent: 'AUTHORIZE',
            purchase_units: [{ invoice_id: bidId, amount: usd(229), description: 'Holdfast S7 card-fields bid' }],
            payment_source: { card: {
              attributes: { verification: { method: 'SCA_WHEN_REQUIRED' }, vault: { store_in_vault: 'ON_SUCCESS' } },
              experience_context: { return_url: `${ORIGIN}/?3ds=return`, cancel_url: `${ORIGIN}/?3ds=cancel` },
            } },
          },
        });
        cardBids.set(r.json.id, { bidId, create: strip(r) });
        console.log(`[s1] order create ${r.http} ${r.json.status ?? r.issue ?? r.name}`);
        return send(res, r.http < 300 ? 200 : 502, { orderId: r.json.id, http: r.http, status: r.json.status, issue: r.issue ?? r.name });
      }
      if (url.pathname === '/api/card/authorize') {
        const { orderId, submit } = await readBody(req);
        const b = cardBids.get(orderId);
        if (!b) return send(res, 404, { error: 'unknown order' });
        const out = await authorizeAndRecord('s1', orderId, b.bidId, { create: b.create, submit });
        console.log(`[s1] authorize → ${out.authStatus}, vault ${out.vaultStatus}`);
        return send(res, 200, out);
      }
      if (url.pathname === '/api/card/submit-failed') {
        const { orderId, submit } = await readBody(req);
        const b = cardBids.get(orderId) ?? {};
        saveAttempt('s1', { pass: false, orderId, bidId: b.bidId, create: b.create, submit, calls: b.create ? [b.create] : [] });
        return send(res, 200, { recorded: true });
      }

      // Step 2: wallet order → payer-action redirect → return → authorize.
      if (url.pathname === '/api/wallet/order') {
        const bidId = randomUUID();
        const body = (vault) => ({
          intent: 'AUTHORIZE',
          purchase_units: [{ invoice_id: bidId, amount: usd(229), description: 'Holdfast S7 wallet bid' }],
          payment_source: { paypal: {
            ...(vault ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } } } : {}),
            experience_context: { return_url: `${ORIGIN}/wallet-return`, cancel_url: `${ORIGIN}/?wallet=cancel`, user_action: 'CONTINUE', shipping_preference: 'NO_SHIPPING', brand_name: 'Holdfast S7' },
          } },
        });
        const withVault = url.searchParams.get('vault') !== '0';
        const r = await pp('POST', '/v2/checkout/orders', { label: `order create (wallet${withVault ? ' + vault' : ''})`, requestId: bidId, body: body(withVault) });
        const link = r.json.links?.find((l) => l.rel === 'payer-action')?.href;
        cardBids.set(r.json.id, { bidId, create: strip(r), wallet: true, withVault });
        console.log(`[s2] wallet order ${r.http} ${r.json.status ?? r.issue ?? r.name}; payer-action link: ${!!link}`);
        if (!link) saveAttempt('s2', { pass: false, orderId: r.json.id, bidId, withVault, calls: [strip(r)] });
        return send(res, link ? 200 : 502, { orderId: r.json.id, payerAction: link, http: r.http, status: r.json.status, issue: r.issue ?? r.name });
      }
      if (url.pathname === '/wallet-return') {
        const orderId = url.searchParams.get('token');
        const b = cardBids.get(orderId);
        if (!b) return send(res, 404, `<p>unknown order ${orderId}</p>`, 'text/html');
        const before = await getOrder(orderId);
        const out = await authorizeAndRecord('s2', orderId, b.bidId, { create: b.create, withVault: b.withVault, returnParams: { hasPayerId: url.searchParams.has('PayerID') }, orderBefore: strip(before) });
        console.log(`[s2] wallet authorize → ${out.authStatus}, vault ${out.vaultStatus}`);
        return send(res, 200, `<!doctype html><title>S7 wallet result</title><h1 id="result">wallet ${out.pass ? 'PASS' : 'FAIL'}</h1><p>order before authorize: ${before.bodyStatus}</p><pre id="detail">${JSON.stringify(out, null, 2)}</pre><p><a href="/">back</a></p>`, 'text/html');
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[serve]', e.message);
      send(res, 500, { error: e.message });
    }
  }).listen(PORT, () => console.log(`S7 browser harness on ${ORIGIN}`));
}

// ---------- render evidence into s7-results.md ----------
const cell = (v) => (v === undefined || v === null || v === '' ? '–' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '));
function callTable(calls = []) {
  const rows = calls.map((c) => `| ${cell(c.label)} | \`${cell(c.requestId)}\` | ${cell(c.http)} | ${cell(c.bodyStatus)} | ${cell(c.issue ?? c.name)} | ${cell(c.debugId)} | ${cell(c.ms)} | ${cell(c.note)} |`);
  return ['| call | PayPal-Request-Id | HTTP | body status | issue / name | debug id | ms | note |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}
function renderStep(step, title) {
  const all = loadEv(step);
  if (!all.length) return `### ${title}\n\n_Not run._\n`;
  const last = all.at(-1);
  if (step === 's7-payout') {
    const rows = all.map((a) => {
      const post = a.calls[0] ?? {};
      return `| ${a.ranAt.slice(11, 19)} | ${a.summary.value} | ${Math.ceil(a.summary.value / (a.summary.perItem || a.summary.value))} | \`${cell(post.requestId)}\` | ${cell(post.http)} | ${cell(post.issue ?? post.name ?? post.bodyStatus)} | ${cell(a.summary.batchStatus)} | ${cell(a.summary.itemStatus)}${a.calls.find((c) => /item final/.test(c.note ?? ''))?.note.match(/FAILED (\w+)/)?.[1] ? ' ' + a.calls.find((c) => /item final/.test(c.note)).note.match(/FAILED (\w+)/)[1] : ''} | ${cell(post.debugId)} |`;
    });
    return `### ${title}\n\nEvery payout attempt (UTC time; each uses a fresh \`sender_batch_id\`):\n\n| time | USD | items | sender_batch_id | POST HTTP | POST issue / status | batch final | item final | debug id |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
  }
  const hist = all.length > 1 ? `\nAttempts: ${all.map((a) => `${a.ranAt} ${a.pass ? 'PASS' : 'FAIL'}`).join(' · ')}\n` : '';
  let out = `### ${title}\n\nLast run ${last.ranAt}: **${last.pass ? 'PASS' : 'FAIL'}**${hist}\n`;
  if (last.submit) out += `\nBrowser \`submit()\` result: \`${JSON.stringify(last.submit)}\`\n`;
  if (last.vaultStatus) out += `\nVault after authorize: **${last.vaultStatus}**${last.vaultId ? ` (id ${short(last.vaultId)})` : ''}\n`;
  const calls = [...(last.create ? [last.create] : []), ...(last.orderBefore ? [{ ...last.orderBefore, note: 'order state on return' }] : []), ...(last.calls ?? []).filter((c) => c !== last.create)];
  if (calls.length) out += `\n${callTable(calls)}\n`;
  if (last.summary) out += `\n\`\`\`json\n${JSON.stringify(last.summary, (k, v) => (k === 'polls' && Array.isArray(v) ? v.filter((_, i) => i < 3 || i === v.length - 1) : v), 2)}\n\`\`\`\n`;
  return out;
}
function render() {
  const body = [
    renderStep('s1', 'Step 1: card fields (JS SDK v6) + authorize + vault'),
    renderStep('s2', 'Step 2: wallet approve + authorize (+ vault?)'),
    renderStep('s3', 'Step 3: replays (order create, authorize, void ×2, capture ×2)'),
    renderStep('s3x', 'Step 3 (cont.): which order-create replays return the same order'),
    renderStep('s4', 'Step 4: vault: MIT ×2 from one vault_id, CIT hold'),
    renderStep('s5', 'Step 5: mock AUTHORIZATION_EXPIRED on capture'),
    renderStep('s6', 'Step 6: volume: 300 holds, 5 test cards, concurrency 20'),
    renderStep('s7', 'Step 7: capture ≥ $50k → ≈ $50k payout → GET batch + item → void the rest'),
    renderStep('s7-payout', 'Step 7 (cont.): payout retries'),
    renderStep('cleanup', 'Final check: every spike authorization GET-checked, none left CREATED'),
  ].join('\n');
  const START = '<!-- s7-evidence:start -->', END = '<!-- s7-evidence:end -->';
  const md = existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8') : `# Spike S7 results (HF-063)\n\n${START}\n${END}\n`;
  writeFileSync(RESULTS, md.slice(0, md.indexOf(START) + START.length) + `\n_Generated by \`node spikes/paypal-s7.mjs render\` from spikes/s7-evidence/._\n\n${body}\n` + md.slice(md.indexOf(END)));
  console.log('wrote spikes/s7-results.md');
}

// ---------- CLI ----------
const brief = (a) => ({ pass: a.pass, ...(a.summary ?? {}), ...(a.calls ? { calls: a.calls.map(({ label, http, bodyStatus, issue, name, note }) => [label, http, bodyStatus, issue ?? name, note].filter((x) => x !== undefined).join(' | ')) } : {}) });
const cmds = { s3, s3x, s4, s5, s6, s7, payout, cleanup };
const cmd = process.argv[2];
if (cmd === 'serve') await serve();
else if (cmd === 'render') render();
else if (cmds[cmd]) {
  const out = await cmds[cmd](...process.argv.slice(3));
  const { holds, caps, ...rest } = out;
  console.log(JSON.stringify(brief(rest), null, 2));
} else {
  console.log('usage: node spikes/paypal-s7.mjs serve|s3|s4|s5|s6|s7|cleanup|render');
  process.exit(1);
}
