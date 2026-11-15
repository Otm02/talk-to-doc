import { describe, expect, it } from "vitest";
import type { FailureCode } from "../realtime/failure";
import { initialState, type RealtimeState } from "../realtime/state";
import { isInProgress, isLive, statusInfo } from "./status-map";

const s = (over: Partial<RealtimeState>): RealtimeState => ({
  ...initialState,
  ...over,
});
const connected = (over: Partial<RealtimeState> = {}) =>
  s({ connection: { status: "connected" }, ...over });
const failed = (code: FailureCode) =>
  s({ connection: { status: "failed", code } });

describe("statusInfo", () => {
  it.each([
    [s({ connection: { status: "requestingMic" } }), "Connecting"],
    [
      s({ connection: { status: "connecting", phase: "minting" } }),
      "Connecting",
    ],
    [connected({ activity: "listening" }), "Listening"],
    [connected({ activity: "userSpeaking" }), "You're speaking"],
    [connected({ activity: "thinking" }), "Thinking"],
    [connected({ activity: "assistantSpeaking" }), "Speaking"],
    [connected({ muted: true, activity: "assistantSpeaking" }), "Muted"],
    [
      s({
        connection: {
          status: "reconnecting",
          since: 0,
          phase: "grace",
          attempt: 0,
          maxAttempts: 3,
        },
      }),
      "Reconnecting",
    ],
    [s({ connection: { status: "ended", reason: "user" } }), "Ended"],
  ])("names the state %#", (state, label) => {
    expect(statusInfo(state).label).toBe(label);
  });

  it("does not call a text chat muted, or listening", () => {
    const info = statusInfo(connected({ muted: true, mode: "text" }));
    expect(info.label).toBe("Ready");
    expect(info.kind).toBe("typing");
  });

  it("tracks live and in-progress", () => {
    expect(isLive(connected())).toBe(true);
    expect(
      isLive(
        s({
          connection: {
            status: "reconnecting",
            since: 0,
            phase: "grace",
            attempt: 0,
            maxAttempts: 3,
          },
        }),
      ),
    ).toBe(true);
    expect(isInProgress(s({ connection: { status: "requestingMic" } }))).toBe(
      true,
    );
    expect(
      isInProgress(s({ connection: { status: "ended", reason: "user" } })),
    ).toBe(false);
  });
});

describe("a failed chat says why, honestly", () => {
  it("calls the per-IP 429 a cooldown, not offline", () => {
    expect(statusInfo(failed("rate_limited"))).toEqual({
      kind: "cooldown",
      label: "Cooldown",
      tone: "warning",
    });
  });

  it("calls the daily cap what it is", () => {
    expect(statusInfo(failed("daily_limit"))).toEqual({
      kind: "dailyLimit",
      label: "Daily limit reached",
      tone: "warning",
    });
  });

  it("says Offline when a request failed at the network layer", () => {
    expect(statusInfo(failed("session_network_failed"))).toEqual({
      kind: "offline",
      label: "Offline",
      tone: "error",
    });
  });

  it("says Not connected, not Offline, for a connection that dropped while the device is online", () => {
    expect(statusInfo(failed("session_reconnect_failed"), true).label).toBe(
      "Not connected",
    );
    expect(statusInfo(failed("session_reconnect_failed"), false).label).toBe(
      "Offline",
    );
  });

  it.each([
    "rate_limited",
    "daily_limit",
    "budget_exhausted",
    "voice_disabled",
    "session_connect_failed",
    "session_upstream_busy",
    "doc_not_found",
    "internal",
  ] as const)(
    "never says Offline for %s while the device is online",
    (code) => {
      expect(statusInfo(failed(code), true).label).not.toBe("Offline");
    },
  );

  it.each(["rate_limited", "daily_limit", "session_connect_failed"] as const)(
    "says Offline for %s when navigator.onLine is false",
    (code) => {
      expect(statusInfo(failed(code), false).label).toBe("Offline");
    },
  );

  it.each(["voice_disabled", "budget_exhausted"] as const)(
    "calls %s unavailable",
    (code) => {
      expect(statusInfo(failed(code)).label).toBe("Unavailable");
    },
  );

  it.each([
    "session_connect_failed",
    "session_upstream_busy",
    "doc_not_found",
    "internal",
  ] as const)("calls %s not connected", (code) => {
    expect(statusInfo(failed(code))).toMatchObject({
      label: "Not connected",
      tone: "error",
    });
  });

  it("does not let a lost device link relabel a chat that is still running", () => {
    expect(statusInfo(connected({ activity: "listening" }), false).label).toBe(
      "Listening",
    );
    expect(
      statusInfo(
        s({
          connection: {
            status: "reconnecting",
            since: 0,
            phase: "grace",
            attempt: 0,
            maxAttempts: 3,
          },
        }),
        false,
      ).label,
    ).toBe("Reconnecting");
  });
});

describe("while reconnecting", () => {
  const rc = (
    phase:
      | "grace"
      | "waitingNetwork"
      | "backoff"
      | "minting"
      | "connecting"
      | "cooldown",
    attempt = 1,
  ) =>
    s({
      connection: {
        status: "reconnecting",
        since: 0,
        phase,
        attempt,
        maxAttempts: 3,
      },
    });

  it.each(["grace", "backoff", "minting", "connecting"] as const)(
    "says plain Reconnecting in %s: the attempt count is in the notice line, not the pill",
    (phase) => {
      expect(statusInfo(rc(phase, phase === "grace" ? 0 : 2))).toMatchObject({
        kind: "reconnecting",
        label: "Reconnecting",
      });
    },
  );

  it("says Offline, not Reconnecting, while it waits for the network", () => {
    expect(statusInfo(rc("waitingNetwork"))).toMatchObject({
      kind: "offline",
      label: "Offline",
    });
  });

  it("says Cooldown after a 429, the same word as any other 429", () => {
    expect(statusInfo(rc("cooldown"))).toMatchObject({
      kind: "cooldown",
      label: "Cooldown",
    });
  });

  it("says Offline while the first start waits for the connection", () => {
    expect(
      statusInfo(
        s({ connection: { status: "connecting", phase: "waitingNetwork" } }),
      ).label,
    ).toBe("Offline");
  });

  it("stays live for the chrome around it", () => {
    expect(isLive(rc("cooldown"))).toBe(true);
    expect(isInProgress(rc("waitingNetwork"))).toBe(true);
  });
});
