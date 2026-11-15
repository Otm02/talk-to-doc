import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { del, list } from "@vercel/blob";
import { getEnv } from "../../env";
import { AppError } from "../../errors";
import { enforceRateLimit } from "../../security/rate-limit";
import {
  BLOB_DELETE_TIMEOUT_MS,
  CRON_RATE,
  ORPHAN_UPLOAD_AGE_MS,
} from "./limits";

// Same shape the token route allows (UPLOAD_PATHNAME), with the random suffix
// the SDK adds. Anything else under uploads/ is not ours to delete.
const OURS = /^uploads\/[A-Za-z0-9._-]{1,140}\.pdf$/;

/** Blobs listed per call, and calls per run: a bound on one run's work. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const DELETE_BATCH = 100;

/** Constant-time compare, on hashes so the lengths always match. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function assertCronCaller(req: Request): void {
  const { cronSecret } = getEnv();
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // No secret configured means nobody is authorized, never everybody.
  if (!cronSecret || !given || !sameSecret(given, cronSecret)) {
    throw new AppError("unauthorized", "Unauthorized.", 401);
  }
}

/**
 * GET /api/cron/cleanup, called daily by Vercel Cron with
 * `Authorization: Bearer $CRON_SECRET`. Deletes uploads that a browser put in
 * Blob but never followed with an ingest call (the ingest route deletes a
 * blob as soon as it reads it, so a survivor is an orphan). Only
 * `uploads/*.pdf` older than an hour is touched, so an upload in progress is
 * safe. Answers with a count and nothing else.
 */
export async function cleanupUploads(
  req: Request,
  now: () => number = Date.now,
): Promise<Response> {
  // Counted before the secret is checked, so guessing it is rate limited too.
  await enforceRateLimit(req, "cron-cleanup", CRON_RATE);
  assertCronCaller(req);

  const env = getEnv();
  if (env.uploadMode !== "blob" || !env.blobToken) {
    return Response.json(
      { deleted: 0 },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const token = env.blobToken;
  const cutoff = now() - ORPHAN_UPLOAD_AGE_MS;

  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await list({
      prefix: "uploads/",
      limit: PAGE_SIZE,
      cursor,
      token,
      abortSignal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS),
    });
    const old = result.blobs
      .filter((b) => OURS.test(b.pathname) && b.uploadedAt.getTime() < cutoff)
      .map((b) => b.url);
    for (let i = 0; i < old.length; i += DELETE_BATCH) {
      await del(old.slice(i, i + DELETE_BATCH), {
        token,
        abortSignal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS),
      });
    }
    deleted += old.length;
    if (!result.hasMore || !result.cursor) break;
    cursor = result.cursor;
  }
  return Response.json(
    { deleted },
    { headers: { "cache-control": "no-store" } },
  );
}
