import { describe, expect, it } from "vitest";
import { canonicalUrl, parseYoutubeUrl, thumbnailUrl } from "./parseUrl";

const ID = "dQw4w9WgXcQ";

describe("parseYoutubeUrl: accepted shapes", () => {
  const accepted: Array<[string, string]> = [
    ["watch", `https://www.youtube.com/watch?v=${ID}`],
    ["watch without www", `https://youtube.com/watch?v=${ID}`],
    ["watch over http", `http://www.youtube.com/watch?v=${ID}`],
    ["watch with t", `https://www.youtube.com/watch?v=${ID}&t=42s`],
    ["watch with si", `https://www.youtube.com/watch?v=${ID}&si=abcDEF123`],
    [
      "watch with list",
      `https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=2`,
    ],
    [
      "watch with feature",
      `https://www.youtube.com/watch?v=${ID}&feature=share`,
    ],
    ["watch with pp", `https://www.youtube.com/watch?v=${ID}&pp=ygUDZm9v`],
    [
      "v is not the first param",
      `https://www.youtube.com/watch?feature=share&t=5&v=${ID}`,
    ],
    ["watch with trailing slash", `https://www.youtube.com/watch/?v=${ID}`],
    ["mobile host", `https://m.youtube.com/watch?v=${ID}`],
    ["music host", `https://music.youtube.com/watch?v=${ID}`],
    ["youtu.be", `https://youtu.be/${ID}`],
    ["youtu.be with si and t", `https://youtu.be/${ID}?si=xyz&t=10`],
    ["www.youtu.be", `https://www.youtu.be/${ID}`],
    ["shorts", `https://www.youtube.com/shorts/${ID}`],
    ["shorts with params", `https://youtube.com/shorts/${ID}?feature=share`],
    ["embed", `https://www.youtube.com/embed/${ID}`],
    ["embed with params", `https://www.youtube.com/embed/${ID}?start=30`],
    ["live", `https://www.youtube.com/live/${ID}`],
    ["live with si", `https://www.youtube.com/live/${ID}?si=abc`],
    ["legacy /v/", `https://www.youtube.com/v/${ID}`],
    ["nocookie embed", `https://www.youtube-nocookie.com/embed/${ID}`],
    ["nocookie without www", `https://youtube-nocookie.com/embed/${ID}`],
    ["no scheme", `youtube.com/watch?v=${ID}`],
    ["no scheme youtu.be", `youtu.be/${ID}`],
    ["uppercase host", `https://WWW.YouTube.COM/watch?v=${ID}`],
    ["surrounding whitespace", `  https://youtu.be/${ID}\n`],
    ["fragment", `https://www.youtube.com/watch?v=${ID}#t=1m`],
    ["bare id", ID],
    ["bare id with whitespace", `  ${ID} `],
    ["id with dash and underscore", "a-b_c-d_e-f"],
  ];

  it.each(accepted)("%s", (_name, input) => {
    const result = parseYoutubeUrl(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videoId).toBe(
        input.includes("a-b_c-d_e-f") ? "a-b_c-d_e-f" : ID,
      );
    }
  });

  it("has at least 25 accepted cases", () => {
    expect(accepted.length).toBeGreaterThanOrEqual(25);
  });
});

describe("parseYoutubeUrl: rejected", () => {
  const notYoutube: Array<[string, string]> = [
    ["empty", ""],
    ["whitespace only", "   "],
    ["wrong host", `https://evil.com/watch?v=${ID}`],
    ["lookalike suffix", `https://youtube.com.evil.com/watch?v=${ID}`],
    ["lookalike prefix", `https://evilyoutube.com/watch?v=${ID}`],
    ["subdomain trick", `https://www.youtube.com.evil.com/embed/${ID}`],
    ["userinfo trick", `https://youtube.com@evil.com/watch?v=${ID}`],
    ["javascript scheme", "javascript:alert(1)"],
    ["ftp scheme", `ftp://youtube.com/watch?v=${ID}`],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["not a url", "hello world"],
    ["10-char id", "https://www.youtube.com/watch?v=dQw4w9WgXc"],
    ["12-char id", "https://www.youtube.com/watch?v=dQw4w9WgXcQQ"],
    ["trailing junk on id", `https://youtu.be/${ID}!!`],
    ["invalid char in id", "https://www.youtube.com/watch?v=dQw4w9WgXc%"],
    ["short bare id", "dQw4w9WgXc"],
    ["long bare id", "dQw4w9WgXcQQ"],
    ["unknown youtube subdomain", `https://studio.youtube.com/watch?v=${ID}`],
    ["other video site", `https://vimeo.com/${ID}`],
  ];
  it.each(notYoutube)("%s is not_youtube", (_name, input) => {
    expect(parseYoutubeUrl(input)).toEqual({
      ok: false,
      code: "INVALID_YOUTUBE_URL",
      reason: "not_youtube",
    });
  });

  const noVideoId: Array<[string, string]> = [
    ["playlist", "https://www.youtube.com/playlist?list=PLabc123"],
    ["watch with list only", "https://www.youtube.com/watch?list=PLabc123"],
    ["bare watch", "https://www.youtube.com/watch"],
    ["channel id", "https://www.youtube.com/channel/UCabc123"],
    ["handle", "https://www.youtube.com/@somecreator"],
    ["legacy user url", "https://www.youtube.com/user/someone"],
    ["home page", "https://www.youtube.com/"],
    ["host only", "youtube.com"],
    ["youtu.be without id", "https://youtu.be/"],
    ["shorts without id", "https://www.youtube.com/shorts/"],
    ["embed without id", "https://www.youtube.com/embed"],
    ["music playlist", "https://music.youtube.com/playlist?list=OLAK5uy"],
  ];
  it.each(noVideoId)("%s is no_video_id", (_name, input) => {
    expect(parseYoutubeUrl(input)).toEqual({
      ok: false,
      code: "INVALID_YOUTUBE_URL",
      reason: "no_video_id",
    });
  });
});

describe("canonicalUrl and thumbnailUrl", () => {
  it("rebuilds the canonical watch URL from the id only", () => {
    expect(canonicalUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it("points the thumbnail at the YouTube image host", () => {
    expect(thumbnailUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });
});
