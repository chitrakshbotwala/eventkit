import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooMany = (message: string, retryAfterSec: number) =>
  new HttpError(
    429,
    'rate_limited',
    message,
    { retryAfter: retryAfterSec },
    {
      'retry-after': String(retryAfterSec),
    },
  );
export const unavailable = (code: string, message: string) => new HttpError(503, code, message);

/** Validate untrusted input with a Zod schema; throws a 400 with issue details. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw badRequest(
      'validation_error',
      'Request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
