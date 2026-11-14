import { ERROR_CATALOG, type CatalogCode } from "@/lib/errors/catalog";
import { MAX_PDF_BYTES } from "@/lib/limits";

export type PdfCheck =
  | { ok: true }
  | { ok: false; code: Extract<CatalogCode, `pdf_${string}`> };

/** The same checks the server makes first, so a bad file never leaves the phone. */
export function checkPdfFile(file: Pick<File, "name" | "type" | "size">): PdfCheck {
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
