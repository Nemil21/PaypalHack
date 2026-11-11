#!/usr/bin/env node
// Records Channel3 fixtures for CHANNEL3_MODE=fixtures and CI (HF-009).
//
//   node scripts/channel3-record-fixtures.mjs            REST with CHANNEL3_API_KEY (.env), else keyless MCP
//   node scripts/channel3-record-fixtures.mjs --via mcp  force the keyless MCP free tier (no credits)
//   node scripts/channel3-record-fixtures.mjs --via rest force REST (needs CHANNEL3_API_KEY; 1 credit per search)
//
// Writes fixtures/channel3/search/<slug>.json (one per query) and fixtures/channel3/products/<id>.json
// (the free detail endpoint, one per hit). Product shapes are the same on both paths (the MCP server
// returns the REST `Product` schema); MCP search hits are slimmer (no variants or attributes), which is
// why every hit is also recorded through detail. The API key is sent only as `x-api-key` and never printed.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'fixtures/channel3');

/**
 * The demo product is the fictional Aurel A7 (D15), so its real-world comparison search is generic
 * over-ear ANC headphones; two other categories keep the agent comparisons honest.
 */
export const FIXTURE_QUERIES = [
  { slug: 'over-ear-anc-headphones', query: 'wireless noise cancelling over-ear headphones', role: 'Aurel A7 comparison' },
  { slug: 'portable-bluetooth-speaker', query: 'portable bluetooth speaker waterproof', role: 'second demo product' },
  { slug: 'anc-earbuds', query: 'true wireless noise cancelling earbuds', role: 'third demo product' },
];

const IMAGES_KEPT = 3;

function envKey() {
  if (process.env.CHANNEL3_API_KEY) return process.env.CHANNEL3_API_KEY;
  const f = resolve(root, '.env');
  if (!existsSync(f)) return undefined;
  const m = readFileSync(f, 'utf8').match(/^CHANNEL3_API_KEY=(.*)$/m);
  const v = m?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  return v || undefined;
}

// --- REST -------------------------------------------------------------------------------------

async function rest(key, method, path, body) {
  const r = await fetch(`https://api.trychannel3.com${path}`, {
    method,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Channel3 ${method} ${path} → HTTP ${r.status}`);
  return r.json();
}

const restSource = (key) => ({
  name: 'rest',
  search: (query) => rest(key, 'POST', '/v1/search', { query, limit: 8 }),
  detail: (id) => rest(key, 'GET', `/v1/products/${encodeURIComponent(id)}`),
});

// --- MCP (keyless free tier) ------------------------------------------------------------------

const MCP = 'https://mcp.trychannel3.com/';
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function mcpRpc(body, sid) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const msgs = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  return { sid: r.headers.get('mcp-session-id'), msg: msgs.at(-1) };
}

async function mcpSource() {
  const init = await mcpRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'holdfast-fixtures', version: '1' } },
  });
  const sid = init.sid;
  await mcpRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  let id = 1;
  const call = async (name, args) => {
    const { msg } = await mcpRpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, sid);
    const sc = msg?.result?.structuredContent;
    if (!sc) throw new Error(`Channel3 MCP ${name} returned no structured content`);
    return sc;
  };
  return {
    name: 'mcp',
    search: async (query) => {
      const sc = await call('search_products', { query });
      return { products: sc.products, next_page_token: null };
    },
    detail: async (pid) => {
      const sc = await call('get_products', { product_ids: [pid] });
      const p = sc.products?.[0];
      if (!p) throw new Error(`Channel3 MCP get_products returned nothing for ${pid}`);
      return p;
    },
  };
}

// --- Record -----------------------------------------------------------------------------------

const trim = (p) => ({ ...p, images: (p.images ?? []).slice(0, IMAGES_KEPT) });

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

const via = process.argv.includes('--via') ? process.argv[process.argv.indexOf('--via') + 1] : undefined;
const key = envKey();
if (via === 'rest' && !key) {
  console.error('CHANNEL3_API_KEY is not set (see .env.example).');
  process.exit(1);
}
const src = via === 'mcp' || !key ? await mcpSource() : restSource(key);
const source = src.name === 'rest' ? 'api.trychannel3.com REST' : 'mcp.trychannel3.com keyless free tier';
const recordedAt = new Date().toISOString();

for (const q of FIXTURE_QUERIES) {
  const res = await src.search(q.query);
  const products = (res.products ?? []).map(trim);
  write(resolve(out, 'search', `${q.slug}.json`), {
    _recording: { source, endpoint: 'POST /v1/search', recordedAt, role: q.role },
    request: { query: q.query },
    response: { products, next_page_token: res.next_page_token ?? null },
  });
  console.log(`search ${q.slug}: ${products.length} products`);
  for (const p of products) {
    const detail = trim(await src.detail(p.id));
    write(resolve(out, 'products', `${p.id}.json`), {
      _recording: { source, endpoint: 'GET /v1/products/{id}', recordedAt },
      response: detail,
    });
  }
}
console.log(`fixtures written to ${out} via ${src.name}`);
