import "server-only";
import { BlobIngestBodySchema } from "@/lib/wire/ingest";
import { EnvError, getEnv, type Env } from "../../env";
import { catalogError } from "../../errors";
import { parseWith } from "../../http";
import { enforceRateLimit } from "../../security/rate-limit";
import { getState } from "../../state";
import { deleteBlob, parseOwnBlobUrl, readBlob } from "./blob";
import { openPdf } from "./extract";
import { EXTRACT_TIMEOUT_MS, INGEST_RATE } from "./limits";
import { readMultipartPdf, type UploadedPdf } from "./multipart";
import { createPdfIngestStream } from "./stream";
import { resolveTitle } from "./title";
import { assertPdfBytes } from "./validate";

/**
 * POST /api/ingest/pdf. Both upload modes end up as bytes and one pipeline:
 * guards, parse, then a streamed NDJSON body. Everything that can be refused
 * up front (size, type, rate limit, password, page count) is refused with a
 * normal JSON error and status before the stream starts.
 */
export async function ingestPdf(
  req: Request,
  requestId: string,
): Promise<Response> {
  const startedAt = Date.now();
  const env = getEnv();

  // Before the body is read: a limited client costs us nothing.
  await enforceRateLimit(req, "ingest-pdf", INGEST_RATE);

  const deadline = startedAt + EXTRACT_TIMEOUT_MS;
  const upload =
    env.uploadMode === "blob"
      ? await readFromBlob(req, env, deadline)
      : await readMultipartPdf(req);

  assertPdfBytes(upload.bytes);
  const doc = await openPdf(upload.bytes, deadline);

  const stream = createPdfIngestStream({
    doc,
    documentId: crypto.randomUUID(),
    title: resolveTitle(doc.title, upload.fileName),
    store: getState().documents,
    contextTokenBudget: env.contextTokenBudget,
    ttlMs: env.docTtlMinutes * 60_000,
    requestId,
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Blob mode: the browser already uploaded straight to Blob. The blob is
 * deleted as soon as its bytes are in memory, or the read failed. That is
 * earlier than "after extraction" on purpose: if the function is killed at its
 * time limit mid-extraction, nothing is left behind to leak.
 */
async function readFromBlob(
  req: Request,
  env: Env,
  deadline: number,
): Promise<UploadedPdf> {
  if (!env.blobToken) {
    // Names the variable, never a value. Mapped to config_invalid by the helper.
    throw new EnvError([
      "BLOB_READ_WRITE_TOKEN is required when UPLOAD_MODE=blob",
    ]);
  }
  const body = parseWith(
    BlobIngestBodySchema,
    await req.json().catch(() => {
      throw catalogError("invalid_request");
    }),
  );
  const blob = parseOwnBlobUrl(body.blobUrl, env.blobToken);
  try {
    return {
      bytes: await readBlob(blob, env.blobToken, deadline),
      fileName: body.fileName,
    };
  } finally {
    await deleteBlob(blob, env.blobToken);
  }
}
