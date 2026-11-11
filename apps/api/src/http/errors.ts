import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from '@holdfast/shared';

/**
 * The api.md error envelope `{ error: { code, message, ...details } }` (HF-006). Throw an
 * `ApiError` anywhere in a handler or hook; the error handler below turns it, Zod errors and
 * Fastify's own 4xx errors into the envelope. Anything else is a 500 with no internal detail.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra fields beside `code` and `message`, e.g. `{ reason }` or `{ bidId }`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
  }
}

export function envelope(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ErrorEnvelope {
  return { error: { ...details, code, message } };
}

export function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  return reply.code(err.status).send(envelope(err.code, err.message, err.details));
}

/** `409 STATE_CONFLICT { reason }`. */
export function stateConflict(reason: string, message = 'That action is not allowed right now.') {
  return new ApiError('STATE_CONFLICT', message, { reason });
}

/** Zod issues as `{ path, message }` pairs, safe to return to the client. */
function issuesOf(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/**
 * Validate `data` with `schema` (every route validates its params, query and body with Zod).
 * Throws `400 VALIDATION_ERROR` with the issues on failure.
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown, what = 'request'): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', `Invalid ${what}.`, { issues: issuesOf(result.error) });
  }
  return result.data;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError | z.ZodError | Error, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    if (err instanceof z.ZodError) {
      return sendError(
        reply,
        new ApiError('VALIDATION_ERROR', 'Invalid request.', { issues: issuesOf(err) }),
      );
    }
    // Fastify's own client errors: malformed JSON, wrong content type, body too large, schema.
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      if (status === 429) {
        return sendError(reply, new ApiError('RATE_LIMITED', 'Too many requests.'));
      }
      return sendError(reply, new ApiError('VALIDATION_ERROR', err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send(envelope('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.'));
  });
}
