import type { ApiErrorCode } from '@cockpit/core';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonError(
  c: Context,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): Response {
  return c.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    status as 400,
  );
}

export function handleHttpError(error: unknown, c: Context): Response {
  if (error instanceof HttpError) {
    return jsonError(c, error.status, error.code, error.message, error.details);
  }

  if (error instanceof ZodError) {
    return jsonError(c, 400, 'bad_request', 'The request payload is invalid.', error.issues);
  }

  if (error instanceof HTTPException) {
    const status = error.status;
    const code: ApiErrorCode =
      status === 401
        ? 'unauthorized'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 409
              ? 'conflict'
              : status === 413
                ? 'payload_too_large'
                : status === 429
                  ? 'rate_limited'
                  : 'bad_request';
    return jsonError(c, status, code, error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  return jsonError(c, 500, 'internal_error', 'An internal Cockpit error occurred.', {
    message,
  });
}

export function notFound(c: Context): Response {
  return jsonError(c, 404, 'not_found', 'The requested resource was not found.');
}
