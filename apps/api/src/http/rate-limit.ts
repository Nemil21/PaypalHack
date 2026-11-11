import type { FastifyReply } from 'fastify';
import { ApiError, sendError } from './errors.js';

/**
 * One shared in-memory rate limiter (HF-006, feature 16). A sliding one-minute window per key:
 * the (limit + 1)th call inside any 60 s span is refused with `429 RATE_LIMITED`.
 *
 * In-memory is correct only with **one web instance** (the hackathon deploy; see the README).
 * Several instances would need a shared store (Postgres or Redis) behind the same interface.
 */

export type RateBucket = 'mcp' | 'rest' | 'agent' | 'magicLink';

/** Calls per minute: MCP 30/token, REST 60/user, buyer agent 20 turns/shopper, 3 magic links/email. */
export const RATE_LIMITS: Record<RateBucket, number> = {
  mcp: 30,
  rest: 60,
  agent: 20,
  magicLink: 3,
};

export const RATE_WINDOW_MS = 60_000;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the oldest call in the window leaves it (0 when allowed). */
  retryAfterSec: number;
}

export class RateLimiter {
  /** `${bucket}:${key}` → call timestamps inside the window, oldest first. */
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limits: Record<RateBucket, number> = RATE_LIMITS,
    private readonly now: () => number = Date.now,
    private readonly windowMs = RATE_WINDOW_MS,
  ) {}

  /** Record one call for `key` in `bucket`; refused calls are not counted. */
  hit(bucket: RateBucket, key: string): RateDecision {
    const t = this.now();
    this.sweep(t);
    const limit = this.limits[bucket];
    const id = `${bucket}:${key}`;
    const since = t - this.windowMs;
    const log = (this.hits.get(id) ?? []).filter((at) => at > since);
    if (log.length >= limit) {
      this.hits.set(id, log);
      const retryAfterSec = Math.max(1, Math.ceil((log[0]! + this.windowMs - t) / 1000));
      return { allowed: false, limit, remaining: 0, retryAfterSec };
    }
    log.push(t);
    this.hits.set(id, log);
    return { allowed: true, limit, remaining: limit - log.length, retryAfterSec: 0 };
  }

  /** Drop idle keys once a minute so the map doesn't grow without bound. */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    const since = t - this.windowMs;
    for (const [id, log] of this.hits) {
      if (!log.length || log[log.length - 1]! <= since) this.hits.delete(id);
    }
  }

  /** For tests. */
  reset(): void {
    this.hits.clear();
  }
}

/** Apply a decision: set the headers, and send `429 RATE_LIMITED` when refused. */
export function applyRateDecision(reply: FastifyReply, d: RateDecision): boolean {
  reply.header('RateLimit-Limit', d.limit);
  reply.header('RateLimit-Remaining', d.remaining);
  if (d.allowed) return true;
  reply.header('Retry-After', d.retryAfterSec);
  void sendError(
    reply,
    new ApiError('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.', {
      retryAfterSec: d.retryAfterSec,
    }),
  );
  return false;
}
