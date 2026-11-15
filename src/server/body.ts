import "server-only";
import type { ZodType } from "zod";
import { catalogError } from "./errors";
import { BodyTooLargeError, readStreamCapped } from "./read-capped";

// Byte caps for JSON request bodies, one per route. They are far above what
// the client sends and far below anything a platform would refuse, so they
// only ever stop a hostile caller. The PDF upload has its own cap
// (MAX_PDF_BYTES) and never goes through here.
export const MAX_YOUTUBE_BODY_BYTES = 8 * 1024;
export const MAX_BLOB_INGEST_BODY_BYTES = 8 * 1024;
export const MAX_UPLOAD_TOKEN_BODY_BYTES = 8 * 1024;

export class ReadFailure extends Error {
  constructor(readonly reason: "too_large" | "not_json") {
    super(`Could not read request body: ${reason}`);
    this.name = "ReadFailure";
  }
}

/** Reads a JSON body, counting real bytes so a missing Content-Length does not matter. */
export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<unknown> {
  if (!req.body) throw new ReadFailure("not_json");
  let bytes: Uint8Array;
  try {
    bytes = await readStreamCapped(req.body, maxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new ReadFailure("too_large");
    throw err;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ReadFailure("not_json");
  }
}

/**
 * The one way a route reads JSON: capped while it streams, then checked with
 * zod. Every failure (too big, not JSON, wrong shape) is the same
 * `invalid_request`, so the response says nothing about which check tripped.
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: ZodType<T>,
  maxBytes: number,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await readJsonBody(req, maxBytes);
  } catch (err) {
    if (err instanceof ReadFailure) throw catalogError("invalid_request");
    throw err;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw catalogError("invalid_request");
  return parsed.data;
}
