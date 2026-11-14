import "server-only";
import { z } from "zod";
import { canonicalUrl } from "@/lib/youtube/parseUrl";
import { parseCaptionsXml } from "./captionsXml";
import { withDeadline } from "./deadline";
import { MAX_RESPONSE_CHARS } from "./limits";
import { pickTrack } from "./pickTrack";
import {
  TranscriptError,
  type Transcript,
  type TranscriptProvider,
} from "./provider";

/**
 * Fetches captions straight from YouTube. A TypeScript port of the flow in
 * youtube-transcript-api (MIT licensed, https://github.com/jdepoix/youtube-transcript-api),
 * documented in docs/reference/youtube-transcripts.md:
 *
 *   watch page (consent wall, API key) -> InnerTube player request as the
 *   Android client -> playability check -> pick a caption track -> fetch XML.
 *
 * Works from a home or office IP. YouTube blocks most cloud IPs, which is why
 * the chain puts a hosted provider behind this one.
 */

const INNERTUBE_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38" };
const ACCEPT_LANGUAGE = { "accept-language": "en-US" };

const CONSENT_WALL = 'action="https://consent.youtube.com/s"';
// Real values look like `cb.20240101-00-p0.en+FX+123`. The class is narrow on
// purpose: the value goes into a Cookie header, so no `;`, `,`, quotes or spaces.
const CONSENT_VALUE = /name="v" value="([A-Za-z0-9._+%=-]+)"/;
const INNERTUBE_KEY = /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/;

// Matched on meaning, not byte for byte: YouTube words these however it likes
// and uses a curly apostrophe in "you’re".
const BOT_CHECK = /not a bot/i;
const AGE_CHECK = /inappropriate for some users|age[- ]restricted/i;

const CaptionTrackSchema = z.object({
  baseUrl: z.string(),
  languageCode: z.string(),
  kind: z.string().optional(),
});

const PlayerResponseSchema = z.object({
  playabilityStatus: z
    .object({ status: z.string().optional(), reason: z.string().optional() })
    .optional(),
  videoDetails: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
      lengthSeconds: z.string().optional(),
      isLive: z.boolean().optional(),
      isUpcoming: z.boolean().optional(),
    })
    .optional(),
  captions: z
    .object({
      playerCaptionsTracklistRenderer: z
        .object({
          captionTracks: z.array(CaptionTrackSchema).optional(),
          audioTracks: z
            .array(
              z.object({ defaultCaptionTrackIndex: z.number().optional() }),
            )
            .optional(),
          defaultAudioTrackIndex: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});
type PlayerResponse = z.infer<typeof PlayerResponseSchema>;

export interface DirectProviderOptions {
  /** One deadline for the whole attempt, all requests included. */
  timeoutMs: number;
  /** Extra tries after a network error (not after any HTTP answer). */
  networkRetries: number;
}

export function createDirectProvider(
  options: DirectProviderOptions,
): TranscriptProvider {
  return {
    name: "direct",
    fetch: (videoId, preferredLang, signal) =>
      // One deadline for the whole attempt, all requests included.
      withDeadline(signal, options.timeoutMs, (attempt) =>
        run(videoId, preferredLang, attempt, options),
      ),
  };
}

async function send(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  networkRetries: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      if (signal.aborted || attempt >= networkRetries) throw err;
    }
  }
}

/** 429 is YouTube telling us to go away; anything else non-2xx is a failure. */
function assertOk(res: Response): void {
  if (res.status === 429) throw new TranscriptError("BLOCKED");
  if (!res.ok) {
    throw new TranscriptError("UPSTREAM_FAILED", {
      cause: new Error(`HTTP ${res.status}`),
    });
  }
}

async function readText(res: Response): Promise<string> {
  const text = await res.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new TranscriptError("UPSTREAM_FAILED", {
      cause: new Error("Response too large"),
    });
  }
  return text;
}

async function run(
  videoId: string,
  preferredLang: string,
  signal: AbortSignal,
  options: DirectProviderOptions,
): Promise<Transcript> {
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await send(
      url,
      { headers: { ...ACCEPT_LANGUAGE, ...headers } },
      signal,
      options.networkRetries,
    );
    assertOk(res);
    return readText(res);
  };

  // 1-2. Watch page, past the consent wall, for the InnerTube key.
  const watchUrl = canonicalUrl(videoId);
  let html = await get(watchUrl);
  if (html.includes(CONSENT_WALL)) {
    const value = CONSENT_VALUE.exec(html)?.[1];
    if (!value) throw new TranscriptError("BLOCKED");
    html = await get(watchUrl, { cookie: `CONSENT=YES+${value}` });
    if (html.includes(CONSENT_WALL)) throw new TranscriptError("BLOCKED");
  }
  const apiKey = INNERTUBE_KEY.exec(html)?.[1];
  if (!apiKey) {
    // A captcha page has no key; so does a changed page.
    throw html.includes('class="g-recaptcha"')
      ? new TranscriptError("BLOCKED")
      : new TranscriptError("UPSTREAM_FAILED", {
          cause: new Error("InnerTube key not found"),
        });
  }

  // 3. Player response as the Android client.
  const playerRes = await send(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
    {
      method: "POST",
      headers: { ...ACCEPT_LANGUAGE, "content-type": "application/json" },
      body: JSON.stringify({
        context: { client: INNERTUBE_CLIENT },
        videoId,
      }),
    },
    signal,
    options.networkRetries,
  );
  assertOk(playerRes);
  const player = parsePlayer(await readText(playerRes));

  // 4. Playability, then liveness, before we look for captions.
  assertPlayable(player);

  // 5-6. Caption tracks.
  const renderer = player.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks ?? [];
  if (tracks.length === 0) throw new TranscriptError("NO_CAPTIONS");
  const track = pickTrack(tracks, preferredLang, videoDefaultLang(renderer));
  if (!track) throw new TranscriptError("NO_CAPTIONS");

  // 7. Plain XML, not srv3. A PO-token track cannot be fetched without one.
  if (track.baseUrl.includes("&exp=xpe")) throw new TranscriptError("BLOCKED");
  const captionUrl = track.baseUrl.replace("&fmt=srv3", "");
  assertYoutubeUrl(captionUrl);

  // 8. Parse.
  const xml = await get(captionUrl);
  const segments = parseCaptionsXml(xml);
  if (segments.length === 0) throw new TranscriptError("NO_CAPTIONS");

  const last = segments[segments.length - 1];
  const lastEndSec = last ? Math.ceil((last.startMs + last.durMs) / 1000) : 0;
  const lengthSec = Number.parseInt(
    player.videoDetails?.lengthSeconds ?? "",
    10,
  );
  return {
    title: player.videoDetails?.title?.trim() || "YouTube video",
    channel: player.videoDetails?.author?.trim() ?? "",
    durationSec:
      Number.isFinite(lengthSec) && lengthSec > 0 ? lengthSec : lastEndSec,
    language: track.languageCode,
    isAutoGenerated: track.kind === "asr",
    segments,
  };
}

function parsePlayer(body: string): PlayerResponse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new TranscriptError("UPSTREAM_FAILED", { cause: err });
  }
  const parsed = PlayerResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new TranscriptError("UPSTREAM_FAILED", { cause: parsed.error });
  }
  return parsed.data;
}

/** Order matters: bot check before age, live before the generic "unavailable". */
function assertPlayable(player: PlayerResponse): void {
  const status = player.playabilityStatus?.status;
  const reason = player.playabilityStatus?.reason ?? "";
  const details = player.videoDetails;

  // No verdict at all means the response shape changed, not that the video is gone.
  if (status === undefined) {
    throw new TranscriptError("UPSTREAM_FAILED", {
      cause: new Error("playabilityStatus missing"),
    });
  }
  if (status === "LIVE_STREAM_OFFLINE") {
    throw new TranscriptError("LIVE_NOT_SUPPORTED");
  }
  if (status === "OK") {
    // A finished stream is an ordinary video; one running or scheduled is not.
    if (details?.isLive === true || details?.isUpcoming === true) {
      throw new TranscriptError("LIVE_NOT_SUPPORTED");
    }
    return;
  }
  if (status === "LOGIN_REQUIRED") {
    if (BOT_CHECK.test(reason)) throw new TranscriptError("BLOCKED");
    if (AGE_CHECK.test(reason)) throw new TranscriptError("AGE_RESTRICTED");
  }
  if (status === "AGE_CHECK_REQUIRED") {
    throw new TranscriptError("AGE_RESTRICTED");
  }
  // ERROR, private, region-locked, members-only, anything new: unavailable.
  throw new TranscriptError("VIDEO_UNAVAILABLE");
}

function videoDefaultLang(
  renderer:
    | NonNullable<
        NonNullable<
          PlayerResponse["captions"]
        >["playerCaptionsTracklistRenderer"]
      >
    | undefined,
): string | undefined {
  const audio = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0];
  const index = audio?.defaultCaptionTrackIndex;
  return index === undefined
    ? undefined
    : renderer?.captionTracks?.[index]?.languageCode;
}

/** The URL comes from YouTube's JSON, but we still only follow it to YouTube. */
function assertYoutubeUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    throw new TranscriptError("UPSTREAM_FAILED", { cause: err });
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (host !== "youtube.com" && !host.endsWith(".youtube.com"))
  ) {
    throw new TranscriptError("UPSTREAM_FAILED", {
      cause: new Error("Caption URL left youtube.com"),
    });
  }
}
