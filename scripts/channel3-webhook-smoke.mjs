#!/usr/bin/env node
// S5 smoke for the live Channel3 webhook (HF-042b): posts the recorded offer.price.changed fixture to
// a deployed `/api/webhooks/channel3`, signed the way Channel3 (Svix, Standard Webhooks) signs it,
// then sends the same event again to show the duplicate is a no-op.
//
//   CHANNEL3_WEBHOOK_SECRET=whsec_… node scripts/channel3-webhook-smoke.mjs https://<host>
//   node scripts/channel3-webhook-smoke.mjs https://<host> --unsigned   expect 401
//
// The secret comes from the environment or the repo-root .env and is never printed. This proves our
// side (signature, dedupe, 2xx within 15 s); S5 proper is a delivery Channel3 itself sends (portal
// "Send example" or a real price change), recorded in docs/deploy/render.md.
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function envSecret() {
  if (process.env.CHANNEL3_WEBHOOK_SECRET) return process.env.CHANNEL3_WEBHOOK_SECRET;
  const f = resolve(root, '.env');
  if (!existsSync(f)) return null;
  const line = readFileSync(f, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('CHANNEL3_WEBHOOK_SECRET='));
  return line ? line.slice('CHANNEL3_WEBHOOK_SECRET='.length).trim().replace(/^"|"$/g, '') : null;
}

function sign(secret, id, ts, body) {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

const [base, flag] = process.argv.slice(2);
if (!base) {
  console.error('usage: node scripts/channel3-webhook-smoke.mjs https://<host> [--unsigned]');
  process.exit(2);
}
const url = `${base.replace(/\/+$/, '')}/api/webhooks/channel3`;
const fixture = JSON.parse(
  readFileSync(resolve(root, 'fixtures/channel3/webhooks/offer.price.changed.json'), 'utf8'),
);
const body = JSON.stringify({ ...fixture.body, id: `evt_smoke_${randomUUID()}` });

async function post(label) {
  const headers = { 'content-type': 'application/json' };
  if (flag !== '--unsigned') {
    const secret = envSecret();
    if (!secret) {
      console.error('CHANNEL3_WEBHOOK_SECRET is not set (env or .env).');
      process.exit(2);
    }
    const id = `msg_${randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    Object.assign(headers, {
      'svix-id': id,
      'svix-timestamp': String(ts),
      'svix-signature': sign(secret, id, ts, body),
    });
  }
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body });
  console.log(`${label}: HTTP ${res.status} in ${Date.now() - started} ms ${await res.text()}`);
  return res.status;
}

const first = await post('delivery');
if (flag === '--unsigned') process.exit(first === 401 ? 0 : 1);
const second = await post('duplicate');
process.exit(first === 200 && second === 200 ? 0 : 1);
