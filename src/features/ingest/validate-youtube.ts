import { ERROR_CATALOG } from "@/lib/errors/catalog";
import { parseYoutubeUrl } from "@/lib/youtube/parseUrl";

export type YoutubeCheck =
  | { status: "empty" }
  | { status: "valid"; videoId: string }
  | {
      status: "invalid";
      code: "youtube_bad_url" | "youtube_no_video_id";
      message: string;
    };

/** Live check for the URL field; the server runs the same parser. */
export function checkYoutubeInput(input: string): YoutubeCheck {
  const trimmed = input.trim();
  if (!trimmed) return { status: "empty" };
  const parsed = parseYoutubeUrl(trimmed);
  if (parsed.ok) return { status: "valid", videoId: parsed.videoId };
  const code =
    parsed.reason === "no_video_id" ? "youtube_no_video_id" : "youtube_bad_url";
  return { status: "invalid", code, message: ERROR_CATALOG[code].message };
}
