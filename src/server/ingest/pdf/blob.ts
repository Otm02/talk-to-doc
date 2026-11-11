import "server-only";
import { BlobNotFoundError, del, get } from "@vercel/blob";
import { AppError, catalogError } from "../../errors";
import { BLOB_DELETE_TIMEOUT_MS, MAX_PDF_BYTES } from "./limits";
import { BodyTooLargeError, readStreamCapped } from "./read-capped";

export interface OwnBlob {
  /** Normalized URL, safe to hand to the SDK. */
  url: string;
  access: "private" | "public";
}

// https://<store id>.<private|public>.blob.vercel-storage.com/uploads/<name>.pdf
const BLOB_HOST = /^([a-z0-9]+)\.(private|public)\.blob\.vercel-storage\.com$/;
const BLOB_PATH = /^\/uploads\/[A-Za-z0-9._-]+\.pdf$/;

/**
 * Accepts only a URL that points into OUR store and under uploads/. The store
 * id is the fourth part of the read-write token (vercel_blob_rw_<id>_<secret>),
 * the same way the SDK finds it. Anything else is refused before a request is
 * made, so the endpoint cannot be used to fetch or delete other blobs, and the
 * SDK never sends our token to a host we did not check.
 */
export function parseOwnBlobUrl(raw: string, token: string): OwnBlob {
  const reject = () => catalogError("upload_rejected");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw reject();
  }
  const storeId = token.split("_")[3]?.toLowerCase();
  const host = BLOB_HOST.exec(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !storeId ||
    !host ||
    host[1] !== storeId ||
    !BLOB_PATH.test(url.pathname)
  ) {
    throw reject();
  }
  return {
    url: url.toString(),
    access: host[2] === "public" ? "public" : "private",
  };
}

function mapBlobError(err: unknown, signal: AbortSignal): AppError {
  if (err instanceof AppError) return err;
  if (signal.aborted) return catalogError("pdf_timeout", { cause: err });
  if (err instanceof BlobNotFoundError) {
    return catalogError("upload_missing", { cause: err });
  }
  if (err instanceof BodyTooLargeError) {
    return catalogError("pdf_too_large", { cause: err });
  }
  return new AppError(
    "upstream_failed",
    "We couldn't read your upload. Try again.",
    502,
    err,
  );
}

/** Downloads the blob, refusing anything over the size cap. */
export async function readBlob(
  blob: OwnBlob,
  token: string,
  deadline: number,
): Promise<Uint8Array> {
  // Also aborts the body stream, because the SDK passes the signal to fetch.
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  try {
    const result = await get(blob.url, {
      access: blob.access,
      token,
      abortSignal: signal,
    });
    if (!result || result.statusCode !== 200) {
      throw catalogError("upload_missing");
    }
    if (result.blob.size > MAX_PDF_BYTES) {
      await result.stream.cancel().catch(() => undefined);
      throw catalogError("pdf_too_large");
    }
    return await readStreamCapped(result.stream, MAX_PDF_BYTES);
  } catch (err) {
    throw mapBlobError(err, signal);
  }
}

/**
 * Best effort: a failed delete is logged, not shown to the user, who has
 * already been served (or refused) by the time this matters. The SDK does not
 * throw when the blob is already gone.
 */
export async function deleteBlob(blob: OwnBlob, token: string): Promise<void> {
  try {
    await del(blob.url, {
      token,
      abortSignal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("[blob] delete failed", new URL(blob.url).pathname, err);
  }
}
