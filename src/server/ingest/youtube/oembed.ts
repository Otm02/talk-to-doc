import "server-only";
import { z } from "zod";
import { canonicalUrl } from "@/lib/youtube/parseUrl";
import { withDeadline } from "./deadline";
import { OEMBED_TIMEOUT_MS } from "./limits";

const OembedSchema = z.object({
  title: z.string(),
  author_name: z.string().optional(),
});

export type VideoInfo = { title: string; channel: string };

/**
 * Title and channel from YouTube's public oEmbed endpoint. Supadata's
 * transcript response has neither, and the document header needs a title.
 * Best effort: any failure (blocked, slow, odd shape) is `null`, never an
 * error, because a missing title must not fail an ingest.
 */
export async function fetchVideoInfo(
  videoId: string,
  signal: AbortSignal,
): Promise<VideoInfo | null> {
  try {
    return await withDeadline(signal, OEMBED_TIMEOUT_MS, async (attempt) => {
      const url = new URL("https://www.youtube.com/oembed");
      url.searchParams.set("url", canonicalUrl(videoId));
      url.searchParams.set("format", "json");
      const res = await fetch(url, { signal: attempt });
      if (!res.ok) return null;
      const parsed = OembedSchema.safeParse(await res.json());
      if (!parsed.success) return null;
      const title = parsed.data.title.trim();
      return title === ""
        ? null
        : { title, channel: parsed.data.author_name?.trim() ?? "" };
    });
  } catch {
    return null;
  }
}
