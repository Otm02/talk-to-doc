import "server-only";
import { ZodError } from "zod";
import { EnvError } from "./env";

export type ErrorCode =
  | "invalid_request"
  | "config_invalid"
  | "rate_limited"
  | "not_found"
  | "upstream_failed"
  | "internal";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly userMessage: string,
    readonly httpStatus: number,
    readonly cause?: unknown,
  ) {
    super(userMessage);
    this.name = "AppError";
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
  requestId: string;
}

export interface ErrorResult {
  status: number;
  body: ErrorBody;
}

/**
 * Turns anything thrown into a client-safe response. Only AppError copy and
 * our own config message reach the client; upstream messages and stacks never do.
 */
export function toErrorResult(err: unknown, requestId: string): ErrorResult {
  if (err instanceof AppError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.userMessage }, requestId },
    };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "invalid_request",
          message: "That request was not valid.",
        },
        requestId,
      },
    };
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
  return {
    status: 500,
    body: {
      error: { code: "internal", message: "Something went wrong. Try again." },
      requestId,
    },
  };
}
