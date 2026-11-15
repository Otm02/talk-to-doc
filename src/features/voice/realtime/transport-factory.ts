import { publicEnv } from "@/lib/public-env";
import { isMockScenario, type MockScenarioName } from "./mock-names";
import { TransportError, type RealtimeTransport } from "./transport";
import { WebRtcTransport } from "./webrtc-transport";

/** The mock is for tests and local development: a flag in the URL picks a script. */
export function mockScenarioFromSearch(
  search: string,
  allowed: boolean = publicEnv.isDev || publicEnv.realtimeTransport === "mock",
): MockScenarioName | null {
  if (!allowed) return null;
  const name = new URLSearchParams(search).get("mockRealtime");
  return isMockScenario(name) ? name : null;
}

export async function createTransport(
  ctx: { audioElement: HTMLAudioElement | null },
  search: string,
): Promise<RealtimeTransport> {
  const scenario = mockScenarioFromSearch(search);
  if (scenario) {
    // Dynamic, so the scripts and the fake server are never in the main bundle.
    const [{ MockTransport }, { scenarioScript }] = await Promise.all([
      import("./mock-transport"),
      import("./mock-scenarios"),
    ]);
    const script = scenarioScript(scenario);
    const params = new URLSearchParams(search);
    // Lets a test slow a reply down enough to act on it mid-stream.
    const wordMs = Number(params.get("mockWordMs"));
    return new MockTransport({
      ...script,
      ...(Number.isInteger(wordMs) && wordMs > 0 && { wordMs }),
      // Makes the in-place mic upgrade refuse, to exercise the one reconnect.
      ...(params.get("mockMicUpgrade") === "fail" && { micUpgrade: "fail" }),
    });
  }
  if (typeof RTCPeerConnection === "undefined" || !ctx.audioElement) {
    throw new TransportError("unsupported");
  }
  return new WebRtcTransport({ audioElement: ctx.audioElement });
}
