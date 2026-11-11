// Pure text cleanup for one page of extracted PDF text. No server-only import:
// nothing here is secret and the tests run it directly.

// Presentation forms: Latin ligatures (U+FB00-FB06), Hebrew and Armenian
// forms, and the two Arabic blocks. Only these ranges are NFKC-folded. Full
// NFKC would also rewrite "m²" to "m2", "½" to "1⁄2" and "™" to "TM", which
// changes what a document says.
const PRESENTATION_FORMS = /[\uFB00-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]+/gu;

// C0 and C1 controls except tab, newline, VT, FF and CR, which are whitespace
// handled below. Also the soft hyphen and BOM, which are invisible.
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\uFEFF]/g;

/** A lowercase letter after a hyphen at a line end means a word was split. */
const HYPHENATED = /(\p{L})[-\u2010]\n(\p{Ll})/gu;

export function normalizePageText(raw: string): string {
  return raw
    .replace(PRESENTATION_FORMS, (run) => run.normalize("NFKC"))
    .replace(INVISIBLE, "")
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(HYPHENATED, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Marker between pages in the text the model sees. */
export function pageMarker(page: number): string {
  return `--- Page ${page} ---`;
}

/** Number of characters that are not whitespace, for scan detection. */
export function countVisibleChars(text: string): number {
  let count = 0;
  for (const ch of text) if (!/\s/u.test(ch)) count += 1;
  return count;
}

export function countWords(text: string): number {
  return text.match(/\S+/gu)?.length ?? 0;
}
