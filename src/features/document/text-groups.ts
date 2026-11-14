import { formatTimestamp } from "@/lib/youtube/timestamp";
import { canonicalUrl } from "@/lib/youtube/parseUrl";
import type { DocumentData } from "@/features/ingest/ingest-state";

export const BLOCK_SECONDS = 5 * 60;

export interface TextUnit {
  id: string;
  text: string;
  /** Video only: the timestamp that links to that second on YouTube. */
  stamp?: { label: string; href: string };
}

export interface TextGroup {
  id: string;
  label: string;
  units: TextUnit[];
}

export function timestampHref(videoId: string, startSec: number): string {
  return `${canonicalUrl(videoId)}&t=${Math.floor(startSec)}s`;
}

/** One group per page (PDF) or per 5-minute block (video). */
export function buildGroups(doc: DocumentData): TextGroup[] {
  if (doc.meta.sourceType === "pdf") {
    return doc.pages.map((p) => ({
      id: `p${p.page}`,
      label: `Page ${p.page}`,
      units: [{ id: `p${p.page}`, text: p.text }],
    }));
  }
  const { videoId } = doc.meta;
  const groups: TextGroup[] = [];
  doc.segments.forEach((seg, i) => {
    const block = Math.floor(seg.startSec / BLOCK_SECONDS);
    const id = `b${block}`;
    let group = groups[groups.length - 1];
    if (!group || group.id !== id) {
      group = {
        id,
        label: `${formatTimestamp(block * BLOCK_SECONDS)} – ${formatTimestamp((block + 1) * BLOCK_SECONDS)}`,
        units: [],
      };
      groups.push(group);
    }
    group.units.push({
      id: `s${i}`,
      text: seg.text,
      stamp: {
        label: formatTimestamp(seg.startSec),
        href: timestampHref(videoId, seg.startSec),
      },
    });
  });
  return groups;
}

/** Plain text for Copy: the same markers the model reads. */
export function groupsToPlainText(groups: TextGroup[]): string {
  return groups
    .map((g) =>
      g.units[0]?.stamp
        ? g.units.map((u) => `[${u.stamp?.label ?? ""}] ${u.text}`).join("\n")
        : `[${g.label}]\n${g.units.map((u) => u.text).join("\n")}`,
    )
    .join("\n\n");
}

/** The first ~`limit` characters, cut at a word edge, for the collapsed preview. */
export function previewExcerpt(groups: TextGroup[], limit = 600): string {
  let out = "";
  for (const group of groups) {
    for (const unit of group.units) {
      out += (out ? " " : "") + unit.text.replace(/\s+/g, " ").trim();
      if (out.length > limit) break;
    }
    if (out.length > limit) break;
  }
  if (out.length <= limit) return out;
  const cut = out.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** Splits text around case-insensitive matches. Never builds HTML. */
export function splitByQuery(text: string, query: string): TextPart[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: TextPart[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

export interface MatchIndex {
  total: number;
  /** First global match number inside each unit that has any. */
  base: Map<string, number>;
  count: Map<string, number>;
  /** Group index of each global match, to render far-away groups on demand. */
  groupOfMatch: number[];
}

export function indexMatches(groups: TextGroup[], query: string): MatchIndex {
  const base = new Map<string, number>();
  const count = new Map<string, number>();
  const groupOfMatch: number[] = [];
  const q = query.trim().toLowerCase();
  if (q) {
    groups.forEach((group, gi) => {
      for (const unit of group.units) {
        const lower = unit.text.toLowerCase();
        let n = 0;
        for (
          let at = lower.indexOf(q);
          at !== -1;
          at = lower.indexOf(q, at + q.length)
        ) {
          n += 1;
          groupOfMatch.push(gi);
        }
        if (n > 0) {
          base.set(unit.id, groupOfMatch.length - n);
          count.set(unit.id, n);
        }
      }
    });
  }
  return { total: groupOfMatch.length, base, count, groupOfMatch };
}
