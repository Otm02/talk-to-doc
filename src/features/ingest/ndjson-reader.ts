import {
  IngestLineSchema,
  type DoneLine,
  type MetaLine,
  type PageLine,
  type SegmentLine,
} from "@/lib/wire/ingest";
import { readNdjson, NdjsonError } from "@/lib/wire/ndjson";
import { IngestError, StreamBrokenError, isAbortError } from "./ingest-error";

export type IngestEvent =
  | { type: "meta"; meta: MetaLine }
  | { type: "page"; page: PageLine }
  | { type: "segment"; segment: SegmentLine["segment"] }
  | { type: "done"; done: DoneLine };

/** No bytes for this long on an open stream means it has stalled. */
export const STREAM_IDLE_MS = 30_000;

class IdleError extends Error {}

/** The same stream, failing if nothing arrives for `idleMs`. */
function withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  idleMs: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IdleError()), idleMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // Stop the request behind it: it is not going to deliver.
        void reader.cancel().catch(() => undefined);
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Typed events from an ingest stream. An error line becomes a thrown
 * IngestError with the server's code. A stream that ends with neither `done`
 * nor `error`, goes quiet for `idleMs`, or breaks in transit was cut off, so
 * it throws a StreamBrokenError with `incompleteCode`: what came before it is
 * still good.
 */
export async function* readIngestEvents(
  stream: ReadableStream<Uint8Array>,
  incompleteCode: "upload_failed" | "youtube_failed",
  idleMs: number = STREAM_IDLE_MS,
): AsyncGenerator<IngestEvent> {
  let finished = false;
  try {
    for await (const line of readNdjson(
      withIdleTimeout(stream, idleMs),
      IngestLineSchema,
    )) {
      if ("error" in line) {
        throw new IngestError(line.error.code, line.error.message);
      }
      if ("done" in line) {
        finished = true;
        yield { type: "done", done: line };
      } else if ("sourceType" in line) {
        yield { type: "meta", meta: line };
      } else if ("segment" in line) {
        yield { type: "segment", segment: line.segment };
      } else {
        yield { type: "page", page: line };
      }
    }
  } catch (error) {
    if (error instanceof IngestError || isAbortError(error)) throw error;
    // A bad line, a stall, or the connection breaking mid-body.
    throw new StreamBrokenError(
      incompleteCode,
      error instanceof IdleError
        ? "Stream stalled"
        : error instanceof NdjsonError
          ? error.message
          : "Stream broke",
    );
  }
  if (!finished)
    throw new StreamBrokenError(incompleteCode, "Stream ended early");
}
