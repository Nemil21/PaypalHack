#!/usr/bin/env node
// HF-048b smoke for a deployed Holdfast (docs/deploy/render.md §HF-048b). No dependencies.
//
//   node scripts/smoke-deploy.mjs https://<host>                    # read-only + one real hold
//   node scripts/smoke-deploy.mjs https://<host> --sse-minutes 10   # console live over SSE 10 min
//   node scripts/smoke-deploy.mjs https://<host> --clear            # + Clear → capture/void →
//                                                                    #   promotion → payout (ends the
//                                                                    #   judge listing: run
//                                                                    #   demo:refresh afterwards)
//
// Steps: /healthz and /api/healthz (sandbox) → SPA → one-click demo brand and shopper sign-ins
// (DEMO_MODE, what a judge with no account uses) → the judge offer page → the brand console's SSE
// stream (headers, `: connected`) → an offer-page hold with the labelled sandbox test card → the
// console sees it live → heartbeats every 15 s for `--sse-minutes` → optional Clear and settlement.
// MCP: with HOLDFAST_MCP_TOKEN (a W19 token) it calls initialize + tools/list on /mcp. Channel3:
// with CHANNEL3_WEBHOOK_SECRET it runs scripts/channel3-webhook-smoke.mjs (signed replayed event).
// Tokens and secrets come from the environment and are never printed. Exit 0 only if every step
// that ran passed.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    slug: { type: 'string', default: 'aurel-a7' },
    'sse-minutes': { type: 'string', default: '0.5' },
    clear: { type: 'boolean', default: false },
    amount: { type: 'string' },
    'settle-timeout': { type: 'string', default: '600' },
  },
});
const base = positionals[0]?.replace(/\/+$/, '');
if (!base) {
  console.error(
    'usage: node scripts/smoke-deploy.mjs https://<host> [--slug aurel-a7] [--sse-minutes 10] ' +
      '[--clear] [--amount 23000] [--settle-timeout 600]',
  );
  process.exit(2);
}
const HEARTBEAT_MS = 15_000;
const sseMs = Math.max(0, Number(values['sse-minutes']) * 60_000);
let failures = 0;

const ok = (msg) => console.log(`  ok    ${msg}`);
const skip = (msg) => console.log(`  skip  ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const step = (name) => console.log(`\n${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tiny cookie jar per actor (judges' browsers keep one session each). */
function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    store(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
      }
    },
  };
}

async function call(j, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(j ? { cookie: j.header() } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      // Every mutating route requires one (HF-003b).
      ...(method !== 'GET' ? { 'idempotency-key': `smoke-${randomUUID()}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  j?.store(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Opens an SSE stream and records frames; resolves once headers arrive. */
async function openStream(j, path) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}${path}`, {
    headers: { accept: 'text/event-stream', cookie: j.header() },
    signal: ctrl.signal,
  });
  const s = {
    res,
    events: [],
    pings: [],
    connected: false,
    ended: false,
    close: () => ctrl.abort(),
    waitFor: async (pred, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const hit = s.events.find(pred);
        if (hit) return hit;
        if (s.ended) return null;
        await sleep(250);
      }
      return null;
    },
  };
  if (res.status !== 200 || !res.body) return s;
  (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.includes(': connected')) s.connected = true;
          if (frame.startsWith(': ping')) s.pings.push(Date.now());
          const ev = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (ev) s.events.push({ type: ev, data: data ? JSON.parse(data) : null, at: Date.now() });
        }
      }
    } catch {
      /* aborted */
    }
    s.ended = true;
  })();
  return s;
}

const brand = jar();
const judge = jar();
/** Bids as a fresh shopper, so reruns never hit ALREADY_BID and the judges' demo shopper is untouched. */
const shopper = jar();
let stream = null;

try {
  step(`1. Health (${base})`);
  const h = await call(null, 'GET', '/healthz');
  h.status === 200 && h.json?.db === 'ok' ? ok('/healthz db ok') : fail(`/healthz → ${h.status}`);
  const ah = await call(null, 'GET', '/api/healthz');
  ah.json?.paypalMode === 'sandbox'
    ? ok(`/api/healthz paypalMode sandbox, settlementRunner ${ah.json?.settlementRunner}`)
    : fail(`/api/healthz paypalMode ${ah.json?.paypalMode ?? ah.status} (expected sandbox)`);
  const spa = await call(null, 'GET', '/');
  spa.status === 200 && /<html/i.test(spa.text) ? ok('SPA served') : fail(`/ → ${spa.status}`);

  step('2. Judge access: one-click demo sign-ins (DEMO_MODE)');
  const b = await call(brand, 'POST', '/api/auth/demo/brand', { role: 'OWNER' });
  b.status === 200 && b.json?.brandUser
    ? ok(`demo brand signed in (${b.json.brandUser.role ?? 'OWNER'})`)
    : fail(`POST /api/auth/demo/brand → ${b.status} (is DEMO_MODE=true?)`);
  const s = await call(judge, 'POST', '/api/auth/demo/shopper', {});
  s.status === 200 && s.json?.shopper
    ? ok('demo shopper signed in')
    : fail(`POST /api/auth/demo/shopper → ${s.status}`);
  const fresh = await call(shopper, 'POST', '/api/auth/demo/shopper', {
    email: `smoke-${randomUUID().slice(0, 8)}@holdfast.example`,
  });
  fresh.status === 200 ? ok('fresh smoke shopper signed in') : fail(`smoke shopper → ${fresh.status}`);

  step(`3. Judge listing /o/${values.slug}`);
  const offer = await call(shopper, 'GET', `/api/offers/${encodeURIComponent(values.slug)}`);
  const o = offer.json;
  if (offer.status !== 200 || !o?.listingId) {
    fail(`GET /api/offers/${values.slug} → ${offer.status} (run demo:refresh?)`);
    throw new Error('no judge listing');
  }
  o.status === 'OPEN' && o.biddable
    ? ok(`OPEN and biddable until ${o.windowClosesAt} (${o.brand?.name})`)
    : fail(`listing ${o.status}, biddable ${o.biddable} (run demo:refresh)`);

  step('4. Brand console live stream (SSE behind Render)');
  stream = await openStream(brand, `/api/listings/${o.listingId}/events`);
  const hdr = (k) => stream.res.headers.get(k) ?? '';
  stream.res.status === 200
    ? ok('stream 200')
    : fail(`GET /api/listings/:id/events → ${stream.res.status}`);
  hdr('content-type').startsWith('text/event-stream')
    ? ok('content-type text/event-stream')
    : fail(`content-type ${hdr('content-type')}`);
  hdr('cache-control').includes('no-cache')
    ? ok(`cache-control ${hdr('cache-control')}`)
    : fail(`cache-control ${hdr('cache-control') || '(none)'}`);
  hdr('x-accel-buffering') === 'no'
    ? ok('x-accel-buffering no')
    : fail(`x-accel-buffering ${hdr('x-accel-buffering') || '(none)'}`);
  await sleep(1_500);
  stream.connected ? ok('`: connected` arrived unbuffered') : fail('no `: connected` frame in 1.5 s');

  step('5. Offer-page hold (labelled sandbox test card) → console live update');
  const amount = Number(values.amount ?? o.suggestedBidCents ?? 23_000);
  const bid = await call(
    shopper,
    'POST',
    '/api/bids',
    { listingId: o.listingId, amountCents: amount, paymentMethod: 'TEST_CARD' },
    { 'idempotency-key': `smoke-${randomUUID()}` },
  );
  const bidId = bid.json?.bidId;
  bid.status === 201 && bid.json?.status === 'HELD'
    ? ok(`hold HELD at $${(amount / 100).toFixed(2)} (authorization ${bid.json.authorizationId})`)
    : fail(`POST /api/bids → ${bid.status} ${bid.json?.error?.code ?? bid.json?.status ?? ''}`);
  if (bidId) {
    const seen = await stream.waitFor((e) => e.data?.ids?.bidId === bidId, 15_000);
    seen ? ok(`console got \`${seen.type}\` for the new bid`) : fail('no live event for the bid in 15 s');
  }

  step(`6. Stream stays live for ${(sseMs / 60_000).toFixed(1)} min (15 s heartbeats)`);
  const from = Date.now();
  const startPings = stream.pings.length;
  while (Date.now() - from < sseMs && !stream.ended) await sleep(1_000);
  const pings = stream.pings.slice(startPings);
  const expected = Math.floor(sseMs / HEARTBEAT_MS);
  const gaps = pings.map((t, i) => t - (i ? pings[i - 1] : from));
  const worst = gaps.length ? Math.max(...gaps) : sseMs;
  if (stream.ended) fail(`stream ended after ${((Date.now() - from) / 1000).toFixed(0)} s`);
  else if (sseMs < HEARTBEAT_MS) skip('shorter than one heartbeat (use --sse-minutes 10)');
  else if (pings.length >= Math.max(1, expected - 1) && worst <= 2 * HEARTBEAT_MS + 2_000)
    ok(`${pings.length} heartbeats, longest gap ${(worst / 1000).toFixed(1)} s`);
  else fail(`${pings.length} heartbeats (expected ~${expected}), longest gap ${worst} ms`);

  step('7. Clear → capture / void → promotion → payout');
  if (!values.clear) {
    skip('pass --clear to settle the judge listing (then run demo:refresh on Render)');
  } else {
    const quantity = Math.max(1, Math.min(Number(process.env.SMOKE_CLEAR_QUANTITY ?? 44), 1000));
    const sim = await call(brand, 'GET', `/api/listings/${o.listingId}/simulate?quantity=${quantity}`);
    if (sim.status !== 200) fail(`simulate → ${sim.status}`);
    const clr = await call(
      brand,
      'POST',
      `/api/listings/${o.listingId}/clear`,
      { quantity, expectedGrossCents: sim.json?.grossCents ?? 0 },
      { 'idempotency-key': `smoke-clear-${randomUUID()}` },
    );
    clr.status === 202
      ? ok(`CLEARING: ${clr.json.winners} winners, cutoff $${(clr.json.cutoffCents / 100).toFixed(2)}`)
      : fail(`clear → ${clr.status} ${clr.json?.error?.code ?? ''}`);
    if (clr.status === 202) {
      const until = Date.now() + Number(values['settle-timeout']) * 1000;
      let v = null;
      let sawUpdate = false;
      while (Date.now() < until) {
        v = (await call(brand, 'GET', `/api/listings/${o.listingId}/settlement`)).json;
        sawUpdate ||= stream.events.some((e) => e.type === 'settlement.updated');
        if (v && ['PAID_OUT', 'PAYOUT_FAILED'].includes(v.listingStatus)) break;
        if (v?.listingStatus === 'SETTLED' && v.payout?.status === 'SUCCESS') break;
        await sleep(5_000);
      }
      const c = v?.counts ?? {};
      console.log(
        `        ${v?.listingStatus}: captured ${c.captured} (+${c.capturePending} pending), ` +
          `released ${c.released}, promoted ${c.promoted}, failed ${c.failed}; payout ` +
          `${v?.payout?.status ?? 'none'} ${v?.payout?.itemStatus ?? ''}` +
          (v?.workflowRunId ? `; workflow run ${v.workflowRunId}` : ''),
      );
      c.captured + c.capturePending > 0 ? ok('captures') : fail('no capture');
      c.released > 0 ? ok('losers voided') : fail('no void');
      c.promoted > 0
        ? ok('promotion (decline injected with demo:decline)')
        : skip('no promotion: run `npm run demo:decline` in the Render Shell before --clear');
      ['PAID_OUT'].includes(v?.listingStatus) || v?.payout?.status === 'SUCCESS'
        ? ok('payout SUCCESS')
        : fail(`payout not done (${v?.listingStatus}, ${v?.payout?.status ?? 'none'})`);
      sawUpdate ? ok('console got settlement.updated live') : fail('no live settlement.updated');
    }
  }
} catch (err) {
  if (err.message !== 'no judge listing') fail(`stopped: ${err.message}`);
} finally {
  stream?.close();
}

step('8. MCP (Claude Desktop → /mcp)');
const mcpToken = process.env.HOLDFAST_MCP_TOKEN;
if (!mcpToken) {
  skip('set HOLDFAST_MCP_TOKEN (a W19 token) to call /mcp; then add the server in Claude Desktop');
} else {
  const rpc = async (id, method, params) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mcpToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await r.text();
    const data = text.startsWith('{') ? text : (/^data: (.+)$/m.exec(text)?.[1] ?? 'null');
    return { status: r.status, json: JSON.parse(data) };
  };
  const init = await rpc(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'holdfast-smoke', version: '1' },
  });
  init.status === 200 && init.json?.result?.serverInfo
    ? ok(`initialize: ${init.json.result.serverInfo.name}`)
    : fail(`initialize → ${init.status}`);
  const tools = await rpc(2, 'tools/list', {});
  const names = tools.json?.result?.tools?.map((t) => t.name) ?? [];
  names.length ? ok(`tools/list: ${names.join(', ')}`) : fail(`tools/list → ${tools.status}`);
}

step('9. Channel3 event (signed replay to /api/webhooks/channel3)');
if (!process.env.CHANNEL3_WEBHOOK_SECRET) {
  skip('set CHANNEL3_WEBHOOK_SECRET to run scripts/channel3-webhook-smoke.mjs (S5)');
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, [resolve(here, 'channel3-webhook-smoke.mjs'), base], {
    stdio: 'inherit',
  });
  r.status === 0 ? ok('channel3 webhook smoke passed') : fail('channel3 webhook smoke failed');
}

console.log(failures ? `\nSMOKE FAILED: ${failures} step(s)` : '\nSMOKE PASSED');
process.exit(failures ? 1 : 0);
