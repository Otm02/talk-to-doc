import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { TranscriptProviderName } from "@/lib/wire/ingest";
import { toErrorResult, type ErrorCode } from "./errors";
import { logRequest } from "./log";

/** What a handler can add to its own request log line. Nothing else is loggable. */
export interface RequestMeta {
  provider?: TranscriptProviderName;
  /** Set when a streamed response fails after its 200 was sent. */
  code?: ErrorCode;
}

type Handler = (
  req: Request,
  requestId: string,
  meta: RequestMeta,
) => Promise<Response> | Response;

const NDJSON = "application/x-ndjson";

/**
 * Passes a body through unchanged and calls `onDone` once when it ends, fails
 * or is cancelled. Pull-based, like the streams it wraps, so a slow reader
 * still slows the producer down.
 */
function observeBody(
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          onDone();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        onDone();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        onDone();
      }
    },
  });
}

/**
 * Thin wrapper for route handlers: request id, error mapping, and the one log
 * line per request. `route` is a fixed name chosen where the route is
 * declared, so no part of the URL is logged. A streamed (NDJSON) response is
 * logged when its body ends, so its duration and any late failure are real.
 */
export function handle(route: string, handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const meta: RequestMeta = {};
    const log = () =>
      logRequest({
        requestId,
        route,
        status: response.status,
        durationMs: Date.now() - startedAt,
        provider: meta.provider,
        code: meta.code,
      });

    let response: Response;
    try {
      response = await handler(req, requestId, meta);
      response.headers.set("x-request-id", requestId);
    } catch (err) {
      // Next uses thrown errors to learn that a route reads the request (so it
      // is dynamic). Mapping one to a 500 would hide that from the build.
      unstable_rethrow(err);
      const { status, body, headers } = toErrorResult(err, requestId);
      meta.code = body.error.code;
      response = Response.json(body, {
        status,
        headers: {
          "x-request-id": requestId,
          "cache-control": "no-store",
          ...headers,
        },
      });
    }

    const streamed =
      response.body !== null &&
      (response.headers.get("content-type") ?? "").startsWith(NDJSON);
    if (!streamed || response.body === null) {
      log();
      return response;
    }
    let logged = false;
    const body = observeBody(response.body, () => {
      if (logged) return;
      logged = true;
      log();
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
