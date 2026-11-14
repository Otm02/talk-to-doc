import { describe, expect, it } from "vitest";
import { pickTrack, type CaptionTrack } from "./pickTrack";

const track = (languageCode: string, kind?: "asr"): CaptionTrack => ({
  baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}`,
  languageCode,
  ...(kind ? { kind } : {}),
});

describe("pickTrack", () => {
  it("prefers the requested language when it is manual", () => {
    const tracks = [track("en"), track("fr"), track("de")];
    expect(pickTrack(tracks, "fr")?.languageCode).toBe("fr");
  });

  it("prefers manual English over auto-generated in the requested language", () => {
    const tracks = [track("fr", "asr"), track("en")];
    expect(pickTrack(tracks, "fr")?.languageCode).toBe("en");
  });

  it("uses the video's default language after English", () => {
    const tracks = [track("de"), track("ja")];
    expect(pickTrack(tracks, "fr", "ja")?.languageCode).toBe("ja");
  });

  it("falls back to auto-generated in the requested order", () => {
    const tracks = [track("en", "asr"), track("fr", "asr")];
    expect(pickTrack(tracks, "fr")?.languageCode).toBe("fr");
    expect(pickTrack(tracks, "es")?.languageCode).toBe("en");
  });

  it("matches a regional request against a base-language track and back", () => {
    expect(pickTrack([track("en")], "en-GB")?.languageCode).toBe("en");
    expect(pickTrack([track("pt-BR")], "pt")?.languageCode).toBe("pt-BR");
  });

  it("prefers an exact regional match over the same language", () => {
    const tracks = [track("pt-PT"), track("pt-BR")];
    expect(pickTrack(tracks, "pt-BR")?.languageCode).toBe("pt-BR");
  });

  it("takes the first manual track when no preferred language exists", () => {
    const tracks = [track("ja", "asr"), track("ko"), track("zh")];
    expect(pickTrack(tracks, "fr")?.languageCode).toBe("ko");
  });

  it("takes the first auto-generated track as a last resort", () => {
    expect(pickTrack([track("ja", "asr")], "fr")?.languageCode).toBe("ja");
  });

  it("returns undefined when there are no tracks", () => {
    expect(pickTrack([], "en")).toBeUndefined();
  });

  it("ignores an empty default language", () => {
    expect(pickTrack([track("de")], "fr", "")?.languageCode).toBe("de");
  });
});
