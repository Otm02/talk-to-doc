import "server-only";
import type { TranscriptSegment } from "./provider";

// Hand-written on purpose: the input is untrusted XML from the network, and a
// general parser means entity expansion (billion laughs) and external
// entities. The format is flat (`<text start dur>line</text>`), so we match it
// directly and refuse any DTD outright.

export class CaptionsXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionsXmlError";
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};

const ENTITY =
  /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,9});/g;

function decodeEntity(match: string, body: string): string {
  if (body.startsWith("#")) {
    const code =
      body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    // NUL, surrogates and out-of-range values are not characters.
    const valid =
      code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : "�";
  }
  return NAMED_ENTITIES[body] ?? match;
}

/** One pass of entity decoding. Never recursive, so it cannot expand. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, decodeEntity);
}

const DTD = /<!\s*(DOCTYPE|ENTITY|ELEMENT|ATTLIST)/i;
const TEXT_ELEMENT = /<text\b([^>]*?)(\/>|>([\s\S]*?)<\/text>)/g;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
const TAG = /<[^>]*>/g;
// A caption that is only a sound cue, like "[Music]" or "[Applause] [Laughter]".
const SOUND_TAG_ONLY = /^(?:\[[^\]]*\]\s*)+$/;

function readAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) attributes.set(name, value);
  }
  return attributes;
}

/** Collapses every kind of whitespace, including non-breaking spaces. */
export function collapseWhitespace(text: string): string {
  return text.replace(/[\s ]+/gu, " ").trim();
}

/** True for a caption line that is nothing but a sound tag like [Music]. */
export function isSoundTagOnly(text: string): boolean {
  return SOUND_TAG_ONLY.test(text);
}

/**
 * YouTube double-encodes captions: `&amp;#39;` is an apostrophe. The first
 * decode undoes the XML layer, the second the HTML layer, then any markup the
 * captioner left in (`<i>`, `<font>`) is stripped. Same order as
 * youtube-transcript-api.
 */
function cleanText(raw: string): string {
  return collapseWhitespace(
    decodeEntities(decodeEntities(raw)).replace(TAG, ""),
  );
}

/** Parses the flat `<text start dur>` caption format. Throws on a DTD. */
export function parseCaptionsXml(xml: string): TranscriptSegment[] {
  if (DTD.test(xml)) {
    throw new CaptionsXmlError("DTD or entity declarations are not allowed");
  }

  const segments: TranscriptSegment[] = [];
  for (const match of xml.matchAll(TEXT_ELEMENT)) {
    const attributes = readAttributes(match[1] ?? "");
    const start = Number.parseFloat(attributes.get("start") ?? "");
    if (!Number.isFinite(start) || start < 0) continue;
    const dur = Number.parseFloat(attributes.get("dur") ?? "0");

    const text = cleanText(match[3] ?? "");
    if (text === "" || isSoundTagOnly(text)) continue;

    segments.push({
      startMs: Math.round(start * 1000),
      durMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : 0,
      text,
    });
  }
  // dur is on-screen time, so lines can overlap, but order is by start.
  return segments.sort((a, b) => a.startMs - b.startMs);
}
