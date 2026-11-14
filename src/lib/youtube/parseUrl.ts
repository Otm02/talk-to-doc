// Pure and client-safe: the UI uses it to validate the field as the user
// types, the server uses it as the only gate before anything is fetched.
// Shapes and host list come from docs/reference/youtube-transcripts.md §4.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// Exact host match after lowercasing. Never a substring check:
// `youtube.com.evil.com` must not pass.
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
const ID_AFTER_SEGMENT = new Set(["shorts", "embed", "live", "v"]);

export type ParsedYoutubeUrl =
  | { ok: true; videoId: string }
  | {
      ok: false;
      code: "INVALID_YOUTUBE_URL";
      // not_youtube: wrong host, junk, or a malformed id.
      // no_video_id: a YouTube link that points at a playlist, channel, etc.
      reason: "not_youtube" | "no_video_id";
    };

const NOT_YOUTUBE: ParsedYoutubeUrl = {
  ok: false,
  code: "INVALID_YOUTUBE_URL",
  reason: "not_youtube",
};
const NO_VIDEO_ID: ParsedYoutubeUrl = {
  ok: false,
  code: "INVALID_YOUTUBE_URL",
  reason: "no_video_id",
};

export function parseYoutubeUrl(input: string): ParsedYoutubeUrl {
  const raw = input.trim();
  if (raw === "") return NOT_YOUTUBE;
  // A bare id is what people paste from "Copy video ID".
  if (VIDEO_ID.test(raw)) return { ok: true, videoId: raw };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return NOT_YOUTUBE;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return NOT_YOUTUBE;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return NOT_YOUTUBE;

  const segments = url.pathname.split("/").filter(Boolean);
  let candidate: string | null | undefined;
  if (SHORT_HOSTS.has(host)) {
    candidate = segments[0];
  } else if (segments[0] === "watch") {
    candidate = url.searchParams.get("v");
  } else if (segments[0] !== undefined && ID_AFTER_SEGMENT.has(segments[0])) {
    candidate = segments[1];
  } else {
    // Playlist, channel, @handle, the home page: valid host, no video.
    return NO_VIDEO_ID;
  }

  // A video path with nothing after it is "no video"; a present but
  // malformed id (short, trailing junk) is a bad link.
  if (candidate === undefined || candidate === null || candidate === "") {
    return NO_VIDEO_ID;
  }
  return VIDEO_ID.test(candidate)
    ? { ok: true, videoId: candidate }
    : NOT_YOUTUBE;
}

/** Always rebuilt from the id: the user's raw URL is never forwarded. */
export function canonicalUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
