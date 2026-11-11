import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { forBrand, forShopper, type Db } from '@holdfast/core';
import {
  LISTING_EVENTS_RESYNC,
  type ListingEventNotice,
  type ListingEventType,
} from '@holdfast/shared';
import type { ListingEventBus } from '../events/bus.js';
import { ApiError } from '../http/errors.js';

/**
 * SSE streams on the listing event bus (HF-008; api.md §`GET /listings/:id/events`).
 *
 *   GET /api/listings/:id/events   brand users of the listing's brand (any role)
 *   GET /api/bids/:id/events       the bid's own shopper (M07 `belowCutoff`; HF-038a still polls)
 *
 * Another tenant's listing or bid is a 404, never a 403. Each frame is `event: <type>` plus the
 * small `{listingId, type, ids}` notice as `data`; clients re-fetch details. A `: ping` comment
 * every 15 s keeps proxies (Render) from dropping idle streams, and an `event: resync` frame means
 * "re-fetch everything" (the instance's LISTEN connection dropped and came back).
 */

export interface EventRoutesDeps {
  sql: Db;
  bus: ListingEventBus;
  /** Heartbeat interval (default 15 s); tests shorten it. */
  heartbeatMs?: number;
}

export const HEARTBEAT_MS = 15_000;
/** Client reconnect delay sent as `retry:`. */
const RETRY_MS = 3_000;
/** A client this far behind is dropped (it reconnects and re-fetches). */
const MAX_BUFFERED_BYTES = 1 << 20;
/**
 * Open streams per signed-in user (tabs, devices). Streams are exempt from the per-request REST
 * limit (a 429 would end EventSource for good), so this bounds them instead.
 */
export const MAX_STREAMS_PER_PRINCIPAL = 20;

/** Listing-level notices a shopper may see on their bid's stream (no other bidder's ids). */
const SHOPPER_LISTING_WIDE: ReadonlySet<ListingEventType> = new Set<ListingEventType>([
  'listing.status',
  'listing.updated',
  'round.started',
  'round.extended',
  'round.ended',
  'pricewatch.released',
]);

/** Never on a shopper stream. */
const BRAND_ONLY: ReadonlySet<ListingEventType> = new Set<ListingEventType>(['payout.updated']);

export interface EventStreamStats {
  /** Streams currently open on this instance. */
  open: number;
  /** Per-principal slots in use (sums to `open` unless one leaked). */
  slots: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Open SSE streams and slots on this instance (HF-008; ops and tests). */
    eventStreamStats(): EventStreamStats;
  }
}

const notFound = (what: string) => new ApiError('NOT_FOUND', `${what} not found.`);

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Shopper filter for one bid. Follows the raise chain: once `bid.raised` replaces a bid it tracks,
 * the new bid is tracked too, so the stream keeps working after a raise.
 */
export function bidStreamFilter(bidId: string): (n: ListingEventNotice) => boolean {
  const own = new Set([bidId]);
  return (n) => {
    if (BRAND_ONLY.has(n.type)) return false;
    if (SHOPPER_LISTING_WIDE.has(n.type)) return true;
    if (n.type === 'bid.raised' && n.ids.replacesBidId && own.has(n.ids.replacesBidId)) {
      if (n.ids.bidId) own.add(n.ids.bidId);
      return true;
    }
    return Object.values(n.ids).some((v) => own.has(v));
  };
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRoutesDeps): void {
  const { sql, bus } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const open = new Set<ServerResponse>();
  const perPrincipal = new Map<string, number>();

  // Streams never end on their own; end them so `app.close()` does not hang.
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });

  app.decorate('eventStreamStats', (): EventStreamStats => {
    let slots = 0;
    for (const n of perPrincipal.values()) slots += n;
    return { open: open.size, slots };
  });

  function stream(
    req: FastifyRequest,
    reply: FastifyReply,
    listingId: string,
    filter: (n: ListingEventNotice) => boolean,
  ): void {
    const res = reply.raw;
    // The client may have gone while the tenant lookup was pending; its 'close' already fired,
    // so a listener attached now would never run. Take nothing (no slot, subscription or timer).
    if (req.raw.destroyed || req.raw.socket?.destroyed || res.destroyed) {
      reply.hijack();
      return;
    }

    const p = req.auth.principal!;
    const key = `${p.type}:${p.id}`;
    const count = perPrincipal.get(key) ?? 0;
    if (count >= MAX_STREAMS_PER_PRINCIPAL) {
      throw new ApiError('RATE_LIMITED', 'Too many open live streams; close a tab and retry.');
    }
    perPrincipal.set(key, count + 1);

    reply.hijack();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable proxy buffering (nginx-style proxies honour this).
      'x-accel-buffering': 'no',
    });
    open.add(res);

    const write = (chunk: string) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        res.destroy();
        return;
      }
      res.write(chunk);
    };

    const unsubscribe = bus.subscribe(listingId, {
      onNotice: (n) => {
        if (filter(n)) write(frame(n.type, n));
      },
      onResync: () => write(frame(LISTING_EVENTS_RESYNC, { listingId })),
    });
    const heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      open.delete(res);
      const left = (perPrincipal.get(key) ?? 1) - 1;
      if (left > 0) perPrincipal.set(key, left);
      else perPrincipal.delete(key);
    };
    res.on('close', cleanup);
    // Belt and braces: if the socket died between the check above and here, 'close' is gone too.
    if (res.destroyed || req.raw.socket?.destroyed) {
      cleanup();
      return;
    }

    write(`retry: ${RETRY_MS}\n: connected\n\n`);
    req.log.debug({ listingId }, 'sse stream opened');
  }

  app.get<{ Params: { id: string } }>(
    '/api/listings/:id/events',
    { onRequest: app.guards.requireBrandUser() },
    async (req, reply) => {
      const listing = await forBrand(sql.pool, req.auth.brandUser!.brandId).findListing(
        req.params.id,
      );
      if (!listing) throw notFound('Listing');
      stream(req, reply, listing.id, () => true);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/bids/:id/events',
    { onRequest: app.guards.requireShopper },
    async (req, reply) => {
      const bid = await forShopper(sql.pool, req.auth.shopper!.id).findBid(req.params.id);
      if (!bid) throw notFound('Bid');
      stream(req, reply, bid.listing_id, bidStreamFilter(bid.id));
    },
  );
}
