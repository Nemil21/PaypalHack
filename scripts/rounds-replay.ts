/**
 * Fixture SSE replay for live rounds (HF-036a): `listing.status` → `round.started` →
 * `round.nudged` × N → `bid.raised` × M, built by packages/shared/fixtures/rounds.ts with the real
 * `clear()` numbers. For HF-037a/b (console) and HF-038a/b (buyer side) before a real book exists.
 *
 *   npm run dev:rounds-replay                          # print SSE frames to stdout, 500 ms apart
 *   npm run dev:rounds-replay -- --serve 4036          # serve GET /api/listings/:id/events
 *   npm run dev:rounds-replay -- --delay 0 --raises 5 --bidders 20 --target 8
 *   npm run dev:rounds-replay -- --serve 4036 --round-ms 300000 --end   # console (HF-037a)
 *   npm run dev:rounds-replay -- --serve 4036 --round-ms 300000 --extend --end --end-reason NO_RAISES
 *                                                     # raises feed, late raise, end reason (HF-037b)
 *
 * With `--serve`, every connection replays the sequence for the listing id in its URL, then
 * keeps the stream open with comment heartbeats. Point the web dev proxy's
 * `/api/listings/:id/events` at it (`ROUNDS_REPLAY_PORT=4036 npm run dev -w @holdfast/web`).
 * No database, no PayPal, no secrets.
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import {
  FIXTURE_ROUNDS_LISTING_ID,
  roundsReplayEvents,
  sseFrame,
  type RoundsReplayOptions,
} from '../packages/shared/fixtures/rounds.js';

const { values } = parseArgs({
  options: {
    serve: { type: 'string' },
    delay: { type: 'string', default: '500' },
    bidders: { type: 'string' },
    target: { type: 'string' },
    raises: { type: 'string' },
    listing: { type: 'string' },
    'round-ms': { type: 'string' },
    end: { type: 'boolean', default: false },
    'end-reason': { type: 'string' },
    extend: { type: 'boolean', default: false },
    'extend-ms': { type: 'string' },
  },
});

const int = (v: string | undefined) => (v === undefined ? undefined : Number.parseInt(v, 10));
const delayMs = int(values.delay) ?? 500;
const base: RoundsReplayOptions = {
  bidders: int(values.bidders),
  targetQuantity: int(values.target),
  raises: int(values.raises),
  roundMs: int(values['round-ms']),
  end: values.end,
  endReason: values['end-reason'] as RoundsReplayOptions['endReason'],
  extend: values.extend,
  extendMs: int(values['extend-ms']),
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function replay(listingId: string, write: (frame: string) => boolean | void) {
  const events = roundsReplayEvents({ ...base, listingId, startAt: new Date().toISOString() });
  for (const [i, event] of events.entries()) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    if (write(sseFrame(event, i + 1)) === false) return;
  }
}

if (values.serve === undefined) {
  await replay(values.listing ?? FIXTURE_ROUNDS_LISTING_ID, (f) => {
    process.stdout.write(f);
  });
} else {
  const port = int(values.serve) ?? 4036;
  const route = /^\/api\/listings\/([^/]+)\/events(?:\?.*)?$/;
  const server = createServer((req, res) => {
    const m = req.method === 'GET' ? route.exec(req.url ?? '') : null;
    if (!m) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('GET /api/listings/:id/events\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    let open = true;
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
      open = false;
      clearInterval(heartbeat);
    });
    void replay(decodeURIComponent(m[1]!), (f) => open && res.write(f));
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      `rounds replay: http://127.0.0.1:${port}/api/listings/${FIXTURE_ROUNDS_LISTING_ID}/events`,
    );
  });
}
