import pg from 'pg';
import { LISTING_EVENTS_CHANNEL } from '@holdfast/core';
import { listingEventNoticeSchema, type ListingEventNotice } from '@holdfast/shared';

/**
 * The LISTEN side of the listing event bus (HF-008).
 *
 * Publishers call HF-003a's `emit(tx, …)`, which runs `pg_notify('listing_events', …)` inside the
 * business transaction: Postgres delivers it on COMMIT, to every listening connection on every
 * instance, and drops it on ROLLBACK. Each API instance holds exactly **one** dedicated LISTEN
 * connection (not a pool client, not one per SSE client) and fans notices out in memory to the
 * SSE streams subscribed to that listing.
 *
 * If the connection drops, the bus reconnects with backoff and then calls every subscriber's
 * `onResync`: notices published while it was down are lost, so clients must re-fetch.
 */

export const LISTEN_APPLICATION_NAME = 'holdfast-listen';

export interface BusSubscriber {
  onNotice(notice: ListingEventNotice): void;
  /** The LISTEN connection came back after a drop: re-fetch, notices may have been missed. */
  onResync?(): void;
}

export interface BusLogger {
  warn(obj: object, msg: string): void;
}

export interface ListingEventBusOptions {
  connectionString: string;
  /** Reconnect delays in ms; the last one repeats. */
  backoffMs?: number[];
  log?: BusLogger;
}

const DEFAULT_BACKOFF_MS = [250, 1_000, 2_000, 5_000, 15_000];

export class ListingEventBus {
  private readonly subscribers = new Map<string, Set<BusSubscriber>>();
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private hasConnected = false;
  private closed = false;
  /** LISTEN connections opened over this bus's lifetime (reconnects included). */
  connectionsOpened = 0;

  constructor(private readonly opts: ListingEventBusOptions) {}

  /** Attach a logger after construction (the app logger exists only once the server is built). */
  setLogger(log: BusLogger): void {
    this.opts.log = log;
  }

  /** Open the LISTEN connection. Resolves once listening; failures retry in the background. */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** Number of subscribers across all listings. */
  get subscriberCount(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  /** Subscribe to one listing's notices; returns the unsubscribe function. */
  subscribe(listingId: string, subscriber: BusSubscriber): () => void {
    let set = this.subscribers.get(listingId);
    if (!set) {
      set = new Set();
      this.subscribers.set(listingId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.subscribers.get(listingId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(listingId);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.opts.connectionString,
      application_name: LISTEN_APPLICATION_NAME,
      keepAlive: true,
    });
    // Without a listener an 'error' event would crash the process.
    client.on('error', (err) => this.dropped(client, err));
    client.on('end', () => this.dropped(client));
    client.on('notification', (msg) => {
      if (msg.channel === LISTING_EVENTS_CHANNEL) this.dispatch(msg.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${LISTING_EVENTS_CHANNEL}`);
    } catch (err) {
      client.removeAllListeners('end');
      await client.end().catch(() => {});
      this.opts.log?.warn({ err: (err as Error).message }, 'listing events: LISTEN failed');
      this.scheduleReconnect();
      return;
    }
    if (this.closed) {
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    this.connectionsOpened += 1;
    this.attempt = 0;
    const resumed = this.hasConnected;
    this.hasConnected = true;
    if (resumed) this.resyncAll();
  }

  private dropped(client: pg.Client, err?: Error): void {
    if (this.client !== client) return;
    this.client = null;
    client.removeAllListeners('notification');
    client.end().catch(() => {});
    if (this.closed) return;
    this.opts.log?.warn({ err: err?.message }, 'listing events: LISTEN connection dropped');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 1_000;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
    this.retryTimer.unref();
  }

  private dispatch(payload: string | undefined): void {
    if (!payload) return;
    let notice: ListingEventNotice;
    try {
      notice = listingEventNoticeSchema.parse(JSON.parse(payload));
    } catch {
      this.opts.log?.warn({}, 'listing events: dropped a malformed notice');
      return;
    }
    const set = this.subscribers.get(notice.listingId);
    if (!set) return;
    for (const s of [...set]) {
      try {
        s.onNotice(notice);
      } catch (err) {
        this.opts.log?.warn({ err: (err as Error).message }, 'listing events: subscriber threw');
      }
    }
  }

  private resyncAll(): void {
    for (const set of this.subscribers.values()) {
      for (const s of [...set]) {
        try {
          s.onResync?.();
        } catch {
          // A broken stream cleans itself up on close.
        }
      }
    }
  }
}
