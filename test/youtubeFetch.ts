// A fake YouTube for tests: serves the recorded fixtures through fetch.
import { vi } from "vitest";
import { youtubeFixture, type YoutubeFixtureName } from "./fixtures";

export type Routes = {
  watch?: (n: number, init?: RequestInit) => Response | Promise<Response>;
  player?: (n: number) => Response | Promise<Response>;
  caption?: (url: URL) => Response | Promise<Response>;
};

/**
 * A fetch that plays YouTube from a recorded fixture. Any route can be
 * overridden to break one step. Rejects on abort like the real thing, which
 * the timeout tests rely on.
 */
export function stubYoutube(name: YoutubeFixtureName, routes: Routes = {}) {
  const fixture = youtubeFixture(name);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let watchCalls = 0;
  let playerCalls = 0;

  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push({ url: url.toString(), init });
      if (init?.signal?.aborted) throw init.signal.reason;
      return abortable(respond(url, init), init?.signal);
    },
  );

  /** Real fetch rejects the moment its signal aborts, however slow the server. */
  function abortable<T>(promise: Promise<T>, abort?: AbortSignal | null) {
    if (!abort) return promise;
    return new Promise<T>((resolve, reject) => {
      abort.addEventListener("abort", () => reject(abort.reason), {
        once: true,
      });
      promise.then(resolve, reject);
    });
  }

  const respond = async (url: URL, init?: RequestInit): Promise<Response> => {
    {
      if (url.pathname === "/watch") {
        watchCalls += 1;
        return (
          routes.watch?.(watchCalls, init) ?? new Response(fixture.watchHtml)
        );
      }
      if (url.pathname === "/youtubei/v1/player") {
        playerCalls += 1;
        return routes.player?.(playerCalls) ?? new Response(fixture.player);
      }
      if (url.pathname === "/api/timedtext") {
        if (routes.caption) return routes.caption(url);
        const lang = url.searchParams.get("lang");
        const suffix = url.searchParams.get("kind") === "asr" ? ".asr" : "";
        const xml = fixture.captions[`${lang}${suffix}`];
        return xml ? new Response(xml) : new Response("", { status: 404 });
      }
      throw new Error(`unexpected request: ${url}`);
    }
  };
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/** The parts of a player response the tests change. */
export interface PlayerJson {
  playabilityStatus?: unknown;
  videoDetails?: Record<string, unknown>;
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: Array<{ baseUrl: string }>;
    };
  };
}

/** The fixture's player JSON with one edit applied. */
export function playerWith(
  name: YoutubeFixtureName,
  edit: (player: PlayerJson) => void,
): string {
  const player = JSON.parse(youtubeFixture(name).player) as PlayerJson;
  edit(player);
  return JSON.stringify(player);
}
