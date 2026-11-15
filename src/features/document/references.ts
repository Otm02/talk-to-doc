import type { TextGroup } from "./text-groups";

// Finds the places an answer points to ("page 12", "[04:05]") so the UI can
// turn them into chips that open the full text at that spot. Pure: text in,
// parts out. A reference only becomes a chip when its target exists in this
// document; anything else stays the plain text the model wrote.

export interface ReferenceTarget {
  /** The page or 5-minute block: a TextGroup id. */
  groupId: string;
  /** Video only: the transcript paragraph inside the block. */
  unitId?: string;
}

export type ReferencePart =
  | { kind: "text"; text: string }
  | {
      kind: "ref";
      /** Exactly what the answer said, e.g. "pages 3 to 4". */
      text: string;
      /** What the chip opens, for its accessible name: "page 3", "04:05". */
      label: string;
      target: ReferenceTarget;
    };

export interface ReferenceIndex {
  /** Page number to group id. Empty for a video. */
  pages: ReadonlyMap<number, string>;
  /** Transcript paragraphs in time order. Empty for a PDF. */
  times: ReadonlyArray<{ startSec: number; groupId: string; unitId: string }>;
  /** The last second a timestamp may name and still be inside the video. */
  maxSec: number;
}

const PAGE_GROUP = /^p(\d+)$/;

export function buildReferenceIndex(
  groups: readonly TextGroup[],
  durationSec?: number,
): ReferenceIndex {
  const pages = new Map<number, string>();
  const times: Array<{ startSec: number; groupId: string; unitId: string }> =
    [];
  for (const group of groups) {
    const page = PAGE_GROUP.exec(group.id);
    if (page) pages.set(Number(page[1]), group.id);
    for (const unit of group.units) {
      if (unit.stamp) {
        times.push({
          startSec: unit.stamp.startSec,
          groupId: group.id,
          unitId: unit.id,
        });
      }
    }
  }
  times.sort((a, b) => a.startSec - b.startSec);
  const lastStart = times.at(-1)?.startSec ?? -1;
  return {
    pages,
    times,
    // A video's last paragraph runs on past its own start, up to the end.
    maxSec: times.length === 0 ? -1 : Math.max(lastStart, durationSec ?? 0),
  };
}

// "page 12", "Page 12", "p. 7", and for the plural forms a range or a pair:
// "pages 3 to 4", "pages 3-4", "pp. 3–4", "pages 3 and 4", and in a French
// reply "pages 3 à 4" / "pages 3 et 4". Only the plural takes a second number,
// so "on page 3 and 4 people agreed" stays one page.
const PAGE =
  /\b(?:(?<plural>pages|pp\.)|page|p\.)\s*(?<first>\d{1,4})(?:(?<=\b(?:pages|pp\.)\s*\d{1,4})\s*(?:to|through|and|&|-|–|—|à|et)\s*(?<second>\d{1,4}))?\b/giu;

// "[04:05]" and "[1:04:05]", the same markers the transcript itself uses.
const TIME = /\[(?:(?<h>\d{1,2}):)?(?<m>\d{1,2}):(?<s>\d{2})\]/g;

interface Found {
  at: number;
  text: string;
  label: string;
  target: ReferenceTarget;
}

function findPages(text: string, index: ReferenceIndex): Found[] {
  if (index.pages.size === 0) return [];
  const out: Found[] = [];
  for (const m of text.matchAll(PAGE)) {
    const first = Number(m.groups?.["first"]);
    const secondRaw = m.groups?.["second"];
    const groupId = index.pages.get(first);
    if (groupId === undefined) continue;
    if (secondRaw !== undefined) {
      // A range or pair is one chip, so both ends have to be real pages.
      const second = Number(secondRaw);
      if (!index.pages.has(second) || second < first) continue;
    }
    out.push({
      at: m.index,
      text: m[0],
      label: `page ${first}`,
      target: { groupId },
    });
  }
  return out;
}

function findTimes(text: string, index: ReferenceIndex): Found[] {
  const firstUnit = index.times[0];
  if (!firstUnit) return [];
  const out: Found[] = [];
  for (const m of text.matchAll(TIME)) {
    const g = m.groups ?? {};
    const hours = g["h"] === undefined ? 0 : Number(g["h"]);
    const minutes = Number(g["m"]);
    const seconds = Number(g["s"]);
    // "[75:99]" is not a time; with hours, minutes wrap at 60 too.
    if (seconds > 59 || (g["h"] !== undefined && minutes > 59)) continue;
    const sec = hours * 3600 + minutes * 60 + seconds;
    if (sec > index.maxSec) continue;
    // The paragraph being spoken at that second: the last one that started.
    let unit = firstUnit;
    for (const t of index.times) {
      if (t.startSec > sec) break;
      unit = t;
    }
    out.push({
      at: m.index,
      text: m[0],
      label: m[0].slice(1, -1),
      target: { groupId: unit.groupId, unitId: unit.unitId },
    });
  }
  return out;
}

/** Splits an answer into plain text and references that exist in `index`. */
export function parseReferences(
  text: string,
  index: ReferenceIndex,
): ReferencePart[] {
  const found = [...findPages(text, index), ...findTimes(text, index)].sort(
    (a, b) => a.at - b.at,
  );
  if (found.length === 0) return text === "" ? [] : [{ kind: "text", text }];
  const parts: ReferencePart[] = [];
  let from = 0;
  for (const f of found) {
    if (f.at > from) parts.push({ kind: "text", text: text.slice(from, f.at) });
    parts.push({ kind: "ref", text: f.text, label: f.label, target: f.target });
    from = f.at + f.text.length;
  }
  if (from < text.length) parts.push({ kind: "text", text: text.slice(from) });
  return parts;
}
