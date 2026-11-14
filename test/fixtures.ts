import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** A fresh copy every call, so one test can never change another's input. */
export function pdfFixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    readFileSync(path.join(import.meta.dirname, "fixtures", "pdf", name)),
  );
}

export type YoutubeFixtureName =
  "manual" | "auto-only" | "disabled" | "unavailable";

export interface YoutubeFixture {
  /** The reduced watch page (it only needs to carry the InnerTube key). */
  watchHtml: string;
  /** The scrubbed player response, as JSON text. */
  player: string;
  /** Caption XML by file suffix: "en", "de", "en.asr". */
  captions: Record<string, string>;
}

/** Real YouTube responses, recorded by scripts/record-youtube-fixtures.ts. */
export function youtubeFixture(name: YoutubeFixtureName): YoutubeFixture {
  const dir = path.join(import.meta.dirname, "fixtures", "youtube", name);
  const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const captions: Record<string, string> = {};
  for (const file of readdirSync(dir)) {
    const match = /^captions\.(.+)\.xml$/.exec(file);
    if (match?.[1]) captions[match[1]] = read(file);
  }
  return {
    watchHtml: read("watch.html"),
    player: read("player.json"),
    captions,
  };
}
