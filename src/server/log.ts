import "server-only";
import type { TranscriptProviderName } from "@/lib/wire/ingest";
import type { ErrorCode } from "./errors";

/**
 * The only thing the server logs per request: id, route, status, duration,
 * and when they apply the transcript provider and the error code. All of it
 * is metadata: nothing here can carry document text, a title, a URL, an IP, a
 * secret or an upstream message. Errors are not logged with their message or
 * stack, because those can quote the document or the upstream reply; the
 * `code` is one of our own catalog codes and says what failed.
 */
export interface RequestLog {
  requestId: string;
  /** Fixed name given where the route is declared, never the URL. */
  route: string;
  status: number;
  /** For a streamed body, until the stream closed; otherwise until the response was ready. */
  durationMs: number;
  /** Which transcript provider served a YouTube request. */
  provider?: TranscriptProviderName;
  /**
   * Why a request failed: a catalog code, from a fixed list of our own, never
   * a message. For a stream that failed after its 200, this is the only trace.
   */
  code?: ErrorCode;
}

export function logRequest(entry: RequestLog): void {
  // Built field by field, so an extra property on `entry` is never printed.
  console.info(
    JSON.stringify({
      requestId: entry.requestId,
      route: entry.route,
      status: entry.status,
      durationMs: entry.durationMs,
      ...(entry.provider !== undefined && { provider: entry.provider }),
      ...(entry.code !== undefined && { code: entry.code }),
    }),
  );
}
