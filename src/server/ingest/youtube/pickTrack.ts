import "server-only";

export type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  /** "asr" is auto-generated; absent means a human wrote it. */
  kind?: string;
};

const baseLanguage = (code: string) =>
  (code.toLowerCase().split("-")[0] ?? "").trim();

function find<T extends CaptionTrack>(
  tracks: readonly T[],
  wanted: string,
): T | undefined {
  const lower = wanted.toLowerCase();
  // Exact code first (pt-BR), then the same language (en-US asks for en).
  return (
    tracks.find((t) => t.languageCode.toLowerCase() === lower) ??
    tracks.find((t) => baseLanguage(t.languageCode) === baseLanguage(wanted))
  );
}

/**
 * Manual captions in [requested, English, the video's default], then
 * auto-generated in the same order. A human-written track in a less preferred
 * language beats a machine one in the right language: it is far more accurate.
 * If none of those languages exist, take the first manual track, then the
 * first auto-generated one, so a video only captioned in Japanese still loads.
 */
export function pickTrack<T extends CaptionTrack>(
  tracks: readonly T[],
  preferredLang: string,
  videoDefaultLang?: string,
): T | undefined {
  const manual = tracks.filter((t) => t.kind !== "asr");
  const generated = tracks.filter((t) => t.kind === "asr");
  const order = [preferredLang, "en", videoDefaultLang].filter(
    (lang): lang is string => typeof lang === "string" && lang !== "",
  );

  for (const group of [manual, generated]) {
    for (const lang of order) {
      const hit = find(group, lang);
      if (hit) return hit;
    }
  }
  return manual[0] ?? generated[0];
}
