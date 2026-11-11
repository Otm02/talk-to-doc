import "server-only";
import { catalogError } from "../../errors";
import { MAX_PDF_BYTES, MULTIPART_OVERHEAD_BYTES } from "./limits";
import { BodyTooLargeError, readStreamCapped } from "./read-capped";

export interface UploadedPdf {
  bytes: Uint8Array;
  fileName: string | undefined;
}

/**
 * Direct mode (local and CI): reads field "file" from a multipart body. The
 * body is cut off at the limit while it streams in, so an oversized upload
 * never sits in memory, and the file's own byte count is checked after parsing.
 */
export async function readMultipartPdf(req: Request): Promise<UploadedPdf> {
  const invalid = () => catalogError("invalid_request");

  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !req.body) {
    throw invalid();
  }

  const bodyLimit = MAX_PDF_BYTES + MULTIPART_OVERHEAD_BYTES;
  // Cheap early refusal; the streamed count below is what actually protects us.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > bodyLimit) {
    await req.body.cancel().catch(() => undefined);
    throw catalogError("pdf_too_large");
  }

  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readStreamCapped(req.body, bodyLimit);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw catalogError("pdf_too_large", { cause: err });
    }
    throw invalid();
  }

  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw invalid();
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw invalid();
  if (file.size > MAX_PDF_BYTES) throw catalogError("pdf_too_large");
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name || undefined,
  };
}
