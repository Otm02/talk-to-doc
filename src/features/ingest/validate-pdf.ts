import { ERROR_CATALOG, type CatalogCode } from "@/lib/errors/catalog";
import { MAX_PDF_BYTES } from "@/lib/limits";

export type PdfCheck =
  { ok: true } | { ok: false; code: Extract<CatalogCode, `pdf_${string}`> };

/** The same checks the server makes first, so a bad file never leaves the phone. */
export function checkPdfFile(
  file: Pick<File, "name" | "type" | "size">,
): PdfCheck {
  // Some browsers leave `type` empty for files from a sync folder, so the
  // extension counts too. The server still checks the real bytes.
  const looksLikePdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!looksLikePdf) return { ok: false, code: "pdf_not_pdf" };
  if (file.size === 0) return { ok: false, code: "pdf_empty" };
  if (file.size > MAX_PDF_BYTES) return { ok: false, code: "pdf_too_large" };
  return { ok: true };
}

export function pdfCheckMessage(code: CatalogCode): string {
  return ERROR_CATALOG[code].message;
}

// The server looks for the header in the first KiB (a few bytes of junk may
// come first); the phone looks in the same place.
const HEADER_WINDOW = 1024;

/**
 * Looks at the real bytes, which is what the server does and what the file
 * name and MIME type cannot be trusted for. It runs before any upload token
 * is asked for, so a renamed photo or document costs no Blob upload and no
 * rate-limit slot. A file that cannot be read here is let through: the server
 * checks again and has the last word.
 */
export async function checkPdfHeader(file: Blob): Promise<PdfCheck> {
  try {
    const bytes = new Uint8Array(
      await file.slice(0, HEADER_WINDOW).arrayBuffer(),
    );
    const text = new TextDecoder("latin1").decode(bytes);
    return text.includes("%PDF-")
      ? { ok: true }
      : { ok: false, code: "pdf_not_pdf" };
  } catch {
    return { ok: true };
  }
}
