import "server-only";
import { catalogError } from "../../errors";
import { MAX_PDF_BYTES } from "./limits";

const MAGIC = Buffer.from("%PDF-");
// The PDF spec lets a few bytes of junk precede the header, and pdf.js copes.
const MAGIC_SEARCH_BYTES = 1024;

/**
 * Checks the real bytes, never the file name or the MIME type, which the
 * client controls. Runs before anything is handed to the parser.
 */
export function assertPdfBytes(bytes: Uint8Array): void {
  if (bytes.length === 0) throw catalogError("pdf_empty");
  if (bytes.length > MAX_PDF_BYTES) throw catalogError("pdf_too_large");
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.length, MAGIC_SEARCH_BYTES),
  );
  if (!head.includes(MAGIC)) throw catalogError("pdf_not_pdf");
}
