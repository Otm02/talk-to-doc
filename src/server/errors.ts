import "server-only";
import { ZodError } from "zod";
import { ERROR_CATALOG, type CatalogCode } from "@/lib/errors/catalog";
import { EnvError } from "./env";
import { LimiterUnavailableError } from "./state/types";

export type ErrorCode =
  | "config_invalid"
  | "not_found"
  | "unauthorized"
  | "upstream_failed"
  | CatalogCode;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly userMessage: string,
    readonly httpStatus: number,
    readonly cause?: unknown,
    /** Sent on 429s, as the Retry-After header and as error.retryAfterSec. */
    readonly retryAfterSeconds?: number,
  ) {
    super(userMessage);
    this.name = "AppError";
  }
}

/** Builds an AppError with the status and copy from the shared catalog. */
export function catalogError(
  code: CatalogCode,
  options: { cause?: unknown; retryAfterSeconds?: number } = {},
): AppError {
  const entry = ERROR_CATALOG[code];
  return new AppError(
    code,
    entry.message,
    entry.status,
    options.cause,
    options.retryAfterSeconds,
  );
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Whole seconds until a retry can work. On every 429. */
    retryAfterSec?: number;
  };
  requestId: string;
}

export interface ErrorResult {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

/**
 * Turns anything thrown into a client-safe response. Only AppError copy and
 * our own config message reach the client; upstream messages and stacks never do.
 */
export function toErrorResult(err: unknown, requestId: string): ErrorResult {
  if (err instanceof AppError) {
    const wait = err.retryAfterSeconds;
    return {
      status: err.httpStatus,
      body: {
        error: {
          code: err.code,
          message: err.userMessage,
          // In the body as well as the header: fetch() hides Retry-After
          // from some cross-origin and service-worker setups, and the client
          // countdown needs the number either way.
          ...(wait !== undefined && { retryAfterSec: wait }),
        },
        requestId,
      },
      ...(wait !== undefined && { headers: { "retry-after": String(wait) } }),
    };
  }
  if (err instanceof LimiterUnavailableError) {
    return catalogResult("service_busy", requestId);
  }
  if (err instanceof ZodError) {
    return catalogResult("invalid_request", requestId);
  }
  if (err instanceof EnvError) {
    // Names variables and rules only, never values (see env.ts).
    return {
      status: 500,
      body: {
        error: { code: "config_invalid", message: err.message },
        requestId,
      },
    };
  }
  return catalogResult("internal", requestId);
}

/** The `error` object a client may see for anything thrown. Never carries a message or stack. */
export function publicError(err: unknown): ErrorBody["error"] {
  return toErrorResult(err, "").body.error;
}

function catalogResult(code: CatalogCode, requestId: string): ErrorResult {
  const entry = ERROR_CATALOG[code];
  return {
    status: entry.status,
    body: { error: { code, message: entry.message }, requestId },
  };
}
