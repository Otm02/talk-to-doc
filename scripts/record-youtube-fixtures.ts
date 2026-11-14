// Records real YouTube responses for the DirectProvider tests, once, locally:
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/record-youtube-fixtures.ts
//
// Talks to YouTube only (no OpenAI, no Supadata). What is kept is real; what is
// removed is noise or per-request identity:
//   - watch page: reduced to the one line the provider reads, with a placeholder
//     where the public InnerTube web key goes. The full page is over 1 MB of per-visit tokens.
//   - player JSON: playability, a few videoDetails fields and the caption
//     tracks, with each track's signed baseUrl (it carries the requester's IP)
//     replaced by a plain timedtext URL. streamingData and tracking are gone.
//   - caption XML: stored as YouTube returned it.
// The test suite never touches the network; it serves these files.

import { mkdir, writeFile } from "node:fs/promises";

interface Target {
  dir: string;
  videoId: string;
  /** Caption languages to download; [] for videos with no captions. */
  languages: string[];
}

const TARGETS: Target[] = [
  // Manual captions in two languages (en, de), 19 s.
  { dir: "manual", videoId: "jNQXAC9IVRw", languages: ["en", "de"] },
  // Auto-generated captions only, 56 s.
  { dir: "auto-only", videoId: "_OBlgSz8sSM", languages: ["en"] },
  // Playable video with captions disabled.
  { dir: "disabled", videoId: "dMH0bHeiRNg", languages: [] },
  // A removed video: playabilityStatus ERROR.
  { dir: "unavailable", videoId: "KmtzQCSh6xk", languages: [] },
];

// YouTube's web key is public (every watch page carries it), but it looks like
// a leaked Google API key to secret scanners. The provider only echoes it into
// a URL, so a placeholder tests the same thing.
const FIXTURE_API_KEY = "TEST_PLACEHOLDER_KEY";
const HEADERS = { "accept-language": "en-US" };
const OUT = new URL("../test/fixtures/youtube/", import.meta.url);

interface RawTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: unknown;
  vssId?: string;
  trackName?: string;
  isTranslatable?: boolean;
}

async function record(target: Target): Promise<void> {
  const { dir, videoId, languages } = target;
  const outDir = new URL(`${dir}/`, OUT);
  await mkdir(outDir, { recursive: true });

  const watch = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: HEADERS,
  });
  const html = await watch.text();
  const apiKey = /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/.exec(html)?.[1];
  if (!apiKey) throw new Error(`${videoId}: no InnerTube key (blocked?)`);
  await writeFile(
    new URL("watch.html", outDir),
    `<!doctype html><html><head><script>ytcfg.set({"INNERTUBE_API_KEY":"${FIXTURE_API_KEY}"});</script></head><body></body></html>\n`,
  );

  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
    {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        context: {
          client: { clientName: "ANDROID", clientVersion: "20.10.38" },
        },
        videoId,
      }),
    },
  );
  const player = (await res.json()) as {
    playabilityStatus?: unknown;
    videoDetails?: Record<string, unknown>;
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: RawTrack[];
        audioTracks?: unknown;
        defaultAudioTrackIndex?: number;
      };
    };
  };

  const renderer = player.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks ?? [];

  const playability = (player.playabilityStatus ?? {}) as Record<
    string,
    unknown
  >;
  const scrubbed = {
    // status, reason and the error screen are what the provider reads; the
    // rest is click-tracking tokens.
    playabilityStatus: {
      status: playability.status,
      reason: playability.reason,
      errorScreen: playability.errorScreen,
    },
    videoDetails: player.videoDetails && {
      videoId: player.videoDetails.videoId,
      title: player.videoDetails.title,
      lengthSeconds: player.videoDetails.lengthSeconds,
      author: player.videoDetails.author,
      isLiveContent: player.videoDetails.isLiveContent,
    },
    ...(renderer && {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: tracks.map((t) => ({
            baseUrl:
              `https://www.youtube.com/api/timedtext?v=${videoId}` +
              (t.kind ? `&kind=${t.kind}` : "") +
              `&lang=${t.languageCode}&fmt=srv3`,
            name: t.name,
            vssId: t.vssId,
            languageCode: t.languageCode,
            ...(t.kind && { kind: t.kind }),
            isTranslatable: t.isTranslatable,
          })),
          audioTracks: renderer.audioTracks,
          defaultAudioTrackIndex: renderer.defaultAudioTrackIndex,
        },
      },
    }),
  };
  await writeFile(
    new URL("player.json", outDir),
    `${JSON.stringify(scrubbed, null, 2)}\n`,
  );

  for (const language of languages) {
    const track = tracks.find((t) => t.languageCode === language);
    if (!track) throw new Error(`${videoId}: no ${language} track`);
    // Same transform the provider applies: plain XML, not srv3.
    const xml = await fetch(track.baseUrl.replace("&fmt=srv3", ""), {
      headers: HEADERS,
    });
    if (!xml.ok) throw new Error(`${videoId}: caption fetch ${xml.status}`);
    const suffix = track.kind === "asr" ? ".asr" : "";
    await writeFile(
      new URL(`captions.${language}${suffix}.xml`, outDir),
      `${await xml.text()}\n`,
    );
  }
  console.log(`${dir}: ${videoId} (${tracks.length} tracks)`);
}

for (const target of TARGETS) await record(target);
