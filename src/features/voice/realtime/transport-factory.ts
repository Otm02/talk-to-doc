import { publicEnv } from "@/lib/public-env";
import {
  isMockNet,
  isMockScenario,
  type MockNetName,
  type MockScenarioName,
} from "./mock-names";
import type { MockScript } from "./mock-transport";
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

// Transports this page has built. Only the first one misbehaves under
// ?mockNet=..., so the reconnect that follows gets a clean line.
let mockTransportsBuilt = 0;

/** Test hook. */
export function resetMockNetForTests(): void {
  mockTransportsBuilt = 0;
}

/** What goes wrong, and when (ms after the session is created). */
export function netScript(
  name: MockNetName,
  nth: number,
): Pick<MockScript, "linkSteps" | "steps" | "failWith"> {
  const first = nth === 0;
  switch (name) {
    case "drop-recover":
      return first
        ? {
            steps: [],
            linkSteps: [
              { at: 600, state: "disconnected" },
              { at: 2600, state: "connected" },
            ],
          }
        : { steps: [] };
    case "drop-timeout":
      return first
        ? { steps: [], linkSteps: [{ at: 600, state: "disconnected" }] }
        : { steps: [] };
    case "failed":
      return first
        ? { steps: [], linkSteps: [{ at: 600, state: "failed" }] }
        : { steps: [] };
    case "expired":
      return first
        ? {
            steps: [
              {
                at: 600,
                event: {
                  type: "error",
                  event_id: "evt_expired",
                  error: {
                    type: "invalid_request_error",
                    code: "session_expired",
                    message: "Session expired",
                  },
                },
              },
            ],
          }
        : { steps: [] };
    case "dead":
      return first
        ? { steps: [], linkSteps: [{ at: 600, state: "failed" }] }
        : { steps: [], failWith: "network" };
    default: {
      const unreachable: never = name;
      return unreachable;
    }
  }
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
    const params = new URLSearchParams(search);
    const net = params.get("mockNet");
    const nth = mockTransportsBuilt++;
    const script = {
      ...scenarioScript(scenario),
      ...(isMockNet(net) && netScript(net, nth)),
    };
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
