import { describe, expect, it } from "vitest";
import { initialState, type RealtimeState } from "../realtime/state";
import { isInProgress, isLive, statusInfo } from "./status-map";

const s = (over: Partial<RealtimeState>): RealtimeState => ({ ...initialState, ...over });
const connected = (over: Partial<RealtimeState> = {}) =>
  s({ connection: { status: "connected" }, ...over });

describe("statusInfo", () => {
  it.each([
    [s({ connection: { status: "requestingMic" } }), "Connecting"],
    [s({ connection: { status: "connecting", phase: "minting" } }), "Connecting"],
    [connected({ activity: "listening" }), "Listening"],
    [connected({ activity: "userSpeaking" }), "You're speaking"],
    [connected({ activity: "thinking" }), "Thinking"],
    [connected({ activity: "assistantSpeaking" }), "Speaking"],
    [connected({ muted: true, activity: "assistantSpeaking" }), "Muted"],
    [s({ connection: { status: "reconnecting", since: 0 } }), "Reconnecting"],
    [s({ connection: { status: "failed", code: "daily_limit" } }), "Offline"],
    [s({ connection: { status: "ended", reason: "user" } }), "Ended"],
  ])("names the state %#", (state, label) => {
    expect(statusInfo(state).label).toBe(label);
  });

  it("does not call a text chat muted", () => {
    expect(statusInfo(connected({ muted: true, mode: "text" })).label).toBe("Listening");
  });

  it("tracks live and in-progress", () => {
    expect(isLive(connected())).toBe(true);
    expect(isLive(s({ connection: { status: "reconnecting", since: 0 } }))).toBe(true);
    expect(isInProgress(s({ connection: { status: "requestingMic" } }))).toBe(true);
    expect(isInProgress(s({ connection: { status: "ended", reason: "user" } }))).toBe(false);
  });
});
