import "server-only";
import { formatTimestamp } from "@/lib/youtube/timestamp";
import { PARAGRAPH_SECONDS } from "./limits";
import type { TranscriptSegment } from "./provider";

export type Paragraph = { startSec: number; text: string };

/**
 * Caption lines are two or three seconds long, which is too fine to read or to
 * cite. Merge them into paragraphs of about 30 seconds, each stamped with where
 * it starts. A paragraph closes when the next line starts 30 s or more after
 * the first one, so a long pause never glues two thoughts together.
 */
export function toParagraphs(
  segments: readonly TranscriptSegment[],
  paragraphSeconds: number = PARAGRAPH_SECONDS,
): Paragraph[] {
  const spanMs = paragraphSeconds * 1000;
  const paragraphs: Paragraph[] = [];
  let startMs = 0;
  let lines: string[] = [];

  const flush = () => {
    if (lines.length === 0) return;
    paragraphs.push({
      startSec: Math.floor(startMs / 1000),
      text: lines.join(" "),
    });
    lines = [];
  };

  for (const segment of segments) {
    if (lines.length > 0 && segment.startMs - startMs >= spanMs) flush();
    if (lines.length === 0) startMs = segment.startMs;
    lines.push(segment.text);
  }
  flush();
  return paragraphs;
}

/** The text the model reads: `[mm:ss] paragraph`, blank line between. */
export function renderForModel(paragraphs: readonly Paragraph[]): string {
  return paragraphs
    .map((p) => `[${formatTimestamp(p.startSec)}] ${p.text}`)
    .join("\n\n");
}
