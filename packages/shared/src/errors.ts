import { z } from 'zod';
import { MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS } from './money.js';

/**
 * API error envelope (api.md §Errors): `{ "error": { "code", "message", ...details } }`.
 * One table of codes and HTTP statuses, shared by the API (which sends them) and the web app
 * (which branches on them). `STATE_CONFLICT` carries a `reason`; `ALREADY_BID` a `bidId`.
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  BRAND_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  WINDOW_CLOSED: 409,
  STATE_CONFLICT: 409,
  DUPLICATE: 409,
  ALREADY_BID: 409,
  IN_PROGRESS: 409,
  IDEMPOTENCY_MISMATCH: 422,
  MANDATE_EXCEEDED: 422,
  BELOW_FLOOR: 422,
  ABOVE_MANDATE_MAX: 422,
  HOLD_FAILED: 422,
  PRODUCT_MISMATCH: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PAYPAL_ERROR: 502,
  CHANNEL3_ERROR: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; [detail: string]: unknown };
}

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code);
}

/** A user-entered amount: integer cents, 100–1,000,000 (feature 16 security checklist). */
export const amountCentsSchema = z
  .number()
  .int('must be whole cents')
  .min(MIN_AMOUNT_CENTS, `must be at least ${MIN_AMOUNT_CENTS} cents`)
  .max(MAX_AMOUNT_CENTS, `must be at most ${MAX_AMOUNT_CENTS} cents`);
