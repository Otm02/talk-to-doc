import { ERROR_CATALOG } from "@/lib/errors/catalog";

/** What the error card offers. `try-pdf` switches to the PDF tab. */
export type RecoveryAction =
  | "retry"
  | "pick-another-file"
  | "edit-link"
  | "try-pdf"
  | "reload";

export interface ErrorCopy {
  message: string;
  action: RecoveryAction;
  /** A second, quieter way out, e.g. a PDF when YouTube is blocked. */
  alternative?: "try-pdf";
}

const PICK_ANOTHER_FILE = [
  "pdf_too_large",
  "pdf_empty",
  "pdf_not_pdf",
  "pdf_encrypted",
  "pdf_corrupted",
  "pdf_unreadable",
  "pdf_no_text",
  "pdf_too_many_pages",
] as const;

const EDIT_LINK = [
  "youtube_bad_url",
  "youtube_no_video_id",
  "youtube_no_transcript",
  "youtube_unavailable",
  "youtube_age_restricted",
  "youtube_live",
  "youtube_too_long",
] as const;

function isOneOf(list: readonly string[], code: string): boolean {
  return list.includes(code);
}

// Raised in the browser, with no HTTP status, so it isn't in the server catalog
// (SPEC §4.1 lists it with "—" for status).
const UPLOAD_FAILED_MESSAGE =
  "Upload failed. Check your connection and try again.";

function isCatalogCode(code: string): code is keyof typeof ERROR_CATALOG {
  return Object.hasOwn(ERROR_CATALOG, code);
}

/**
 * Maps a wire code to copy and a recovery action (SPEC §4.1). Copy always
 * comes from the catalog, never from the server's message, so an upstream
 * detail can't reach the screen. Unknown codes fall back to `internal`.
 */
export function errorCopy(code: string): ErrorCopy {
  if (code === "upload_failed") {
    return { message: UPLOAD_FAILED_MESSAGE, action: "retry" };
  }
  const known = isCatalogCode(code) ? code : "internal";
  const message = ERROR_CATALOG[known].message;
  if (isOneOf(PICK_ANOTHER_FILE, known)) {
    return { message, action: "pick-another-file" };
  }
  if (isOneOf(EDIT_LINK, known)) return { message, action: "edit-link" };
  if (known === "youtube_blocked" || known === "youtube_quota") {
    // Retrying won't help for a quota; a PDF always works.
    return { message, action: "try-pdf" };
  }
  if (known === "invalid_request") return { message, action: "reload" };
  return { message, action: "retry" };
}
