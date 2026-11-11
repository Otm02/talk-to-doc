const MAX_TITLE_CHARS = 200;
const FALLBACK = "PDF document";

// Metadata titles are often placeholders left by the authoring tool.
const PLACEHOLDER = /^(untitled|document\d*|microsoft word - .*|\.?pdf)$/i;

function clean(raw: string): string {
  return (
    raw
      // Controls, BOM and bidi overrides: titles end up in prompts and in the UI.
      .replace(
        /[\u0000-\u001F\u007F-\u009F\uFEFF\u202A-\u202E\u2066-\u2069]/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TITLE_CHARS)
      .trim()
  );
}

/** PDF metadata title if it says something, else the file name without ".pdf". */
export function resolveTitle(
  metadataTitle: string | undefined,
  fileName: string | undefined,
): string {
  const fromMetadata = clean(metadataTitle ?? "");
  if (fromMetadata && !PLACEHOLDER.test(fromMetadata)) return fromMetadata;

  // Browsers send a bare name, but strip any path in case another client does not.
  const base = (fileName ?? "").split(/[\\/]/).pop() ?? "";
  const fromFile = clean(base.replace(/\.pdf$/i, ""));
  return fromFile || FALLBACK;
}
