import { IngestLineSchema, type DoneLine, type MetaLine, type PageLine, type SegmentLine } from "@/lib/wire/ingest";
import { readNdjson, NdjsonError } from "@/lib/wire/ndjson";
import { IngestError } from "./ingest-error";

export type IngestEvent =
  | { type: "meta"; meta: MetaLine }
  | { type: "page"; page: PageLine }
  | { type: "segment"; segment: SegmentLine["segment"] }
  | { type: "done"; done: DoneLine };

/**
 * Typed events from an ingest stream. An error line becomes a thrown
 * IngestError with the server's code. A stream that ends with neither `done`
 * nor `error` was cut off, so it throws `incompleteCode`.
 */
export async function* readIngestEvents(
  stream: ReadableStream<Uint8Array>,
  incompleteCode: "upload_failed" | "youtube_failed",
): AsyncGenerator<IngestEvent> {
  let finished = false;
  try {
    for await (const line of readNdjson(stream, IngestLineSchema)) {
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
    if (error instanceof NdjsonError) {
      throw new IngestError(incompleteCode, error.message);
    }
    throw error;
  }
  if (!finished) throw new IngestError(incompleteCode, "Stream ended early");
}
