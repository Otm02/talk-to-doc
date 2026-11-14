import type { SessionResponse } from "@/lib/wire/session";
import {
  createAudioContext,
  createRemoteAudioElement,
  removeAudioElement,
} from "./audio";
import { isDebug } from "./debug";
import { LevelMeter } from "./levels";
import { requestMic } from "./mic";
import { mintSession } from "./mint";
import { EventRecorder } from "./recorder";
import type { SessionDeps } from "./session";
import { createTransport, mockScenarioFromSearch } from "./transport-factory";

// The real wiring of a VoiceSession to the browser. Everything reads
// location lazily: this object is built while rendering, possibly on the
// server, and only touched from event handlers.

const search = () => globalThis.location?.search ?? "";

/** Stands in for the server in mock mode, so no request leaves the page. */
function mockMint(): Promise<SessionResponse> {
  const cap = Number(new URLSearchParams(search()).get("mockCap"));
  return Promise.resolve({
    clientSecret: "mock-secret",
    expiresAt: 0,
    model: "gpt-realtime-2.1-mini",
    maxSessionSeconds: Number.isInteger(cap) && cap > 0 ? cap : 300,
  });
}

export function createBrowserDeps(): SessionDeps {
  return {
    mint: (documentId, signal) =>
      mockScenarioFromSearch(search())
        ? mockMint()
        : mintSession(documentId, signal),
    requestMic: () => requestMic(),
    createTransport: (ctx) => createTransport(ctx, search()),
    createAudioElement: () => createRemoteAudioElement(),
    removeAudioElement,
    createAudioContext: () => createAudioContext(),
    createLevelMeter: (audioContext) => new LevelMeter({ audioContext }),
    createRecorder: () => (isDebug(search()) ? new EventRecorder() : null),
    now: () => Date.now(),
    isDebug: () => isDebug(search()),
    visibility: {
      isHidden: () => document.visibilityState === "hidden",
      subscribe: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    },
  };
}
