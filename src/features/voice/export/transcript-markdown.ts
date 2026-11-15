import type { TranscriptItem } from "../realtime/state";

// The conversation as a Markdown file the user can keep. Pure: the caller
// passes the visible items in order, the date and the model.

export interface TranscriptExport {
  title: string;
  /** The PDF's file name, or the video's URL. */
  source: string;
  date: Date;
  /** null when the chat never got far enough for the server to name one. */
  model: string | null;
  /** Visible items in conversation order. */
  items: readonly TranscriptItem[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The user's own calendar day, as YYYY-MM-DD. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// The words in a transcript come from a PDF, a video and the model, so none of
// them is trusted to be plain text. Markdown viewers such as Obsidian and
// Typora render raw HTML and links, and a line like "---" or "# x" would
// restructure the file. A backslash makes any ASCII punctuation literal in
// CommonMark, so the file still reads naturally as plain text.

/** Inside a line: no raw HTML or autolinks, no inline link with a target. */
function escapeInline(text: string): string {
  return text.replace(/[<>]/g, "\\$&").replace(/\]\(/g, "]\\(");
}

/** A line of a turn: inline escapes, plus anything that would start a block. */
function escapeLine(line: string): string {
  const safe = escapeInline(line);
  return safe
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^([#>+\-*_=~`|])/, "\\$1")
    .replace(/^\[(?=[^\]]*\]:)/, "\\[");
}

/**
 * One turn, or null for a turn with nothing to keep. A turn's text is kept as
 * written, with blank lines closed up so it stays one Markdown paragraph.
 */
function turn(item: TranscriptItem): string | null {
  const who = item.role === "user" ? "**You:**" : "**Assistant:**";
  const text = item.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map(escapeLine)
    .join("\n");
  switch (item.status) {
    case "transcriptionFailed":
      // The turn happened; only its words are missing.
      return `${who} *(not transcribed)*`;
    // Never reached the model, so it is not part of the conversation.
    case "sendFailed":
      return null;
    case "interrupted":
      return text === "" ? null : `${who} ${text} *(interrupted)*`;
    case "transcribing":
    case "sending":
    case "streaming":
    case "done":
      return text === "" ? null : `${who} ${text}`;
    default: {
      const unreachable: never = item.status;
      return unreachable;
    }
  }
}

export function buildTranscriptMarkdown(e: TranscriptExport): string {
  const turns = e.items.flatMap((item) => turn(item) ?? []);
  return [
    `# ${escapeInline(oneLine(e.title)) || "Untitled"}`,
    "",
    `- Source: ${escapeInline(oneLine(e.source)) || "unknown"}`,
    `- Date: ${localDate(e.date)}`,
    `- Model: ${e.model ?? "unknown"}`,
    "",
    ...(turns.length > 0
      ? turns.flatMap((t) => [t, ""])
      : ["*No messages.*", ""]),
  ].join("\n");
}

const MAX_SLUG = 60;

/**
 * Lowercase words joined by dashes. Letters of any script survive, and so do
 * the marks that belong to them (Devanagari vowel signs, Tamil and Thai
 * marks); only the combining accents of Latin letters go, so "Café" becomes "cafe".
 */
export function slugify(title: string): string {
  const folded = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]+/g, "")
    // Hangul and some Indic letters were taken apart by NFKD.
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // By code point, so a cut never splits a surrogate pair.
  const slug = Array.from(folded)
    .slice(0, MAX_SLUG)
    .join("")
    .replace(/-+$/, "");
  return slug || "transcript";
}

/** `<title-slug>-<YYYY-MM-DD>.md` */
export function transcriptFilename(title: string, date: Date): string {
  return `${slugify(title)}-${localDate(date)}.md`;
}
