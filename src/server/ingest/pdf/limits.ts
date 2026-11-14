import "server-only";
import { MAX_PDF_BYTES } from "@/lib/limits";
import type { RateRule } from "../../state";

export { MAX_PDF_BYTES };
export const MAX_PDF_PAGES = 2000;

// A multipart body is the file plus boundaries and headers; this slack keeps
// the read cap from rejecting a file that is exactly at the limit.
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

// Below this average of non-space characters per page we treat the PDF as a
// scan. SPEC §5.1 said 20; 25 is the value chosen for M2.
export const MIN_AVG_CHARS_PER_PAGE = 25;

// maxDuration on the route is 60 s. Stopping at 55 s leaves time to write the
// error line and close the stream.
export const EXTRACT_TIMEOUT_MS = 55_000;
export const MAX_CONCURRENT_EXTRACTIONS = 2;

export const INGEST_RATE: RateRule = { max: 10, windowMs: 60_000 };
export const UPLOAD_TOKEN_RATE: RateRule = { max: 10, windowMs: 60_000 };

export const BLOB_TOKEN_TTL_MS = 5 * 60_000;
export const BLOB_DELETE_TIMEOUT_MS = 10_000;

/** Where browser uploads must land; the ingest route only accepts this prefix. */
export const UPLOAD_PATHNAME = /^uploads\/[A-Za-z0-9._-]{1,100}\.pdf$/;
