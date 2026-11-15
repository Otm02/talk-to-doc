import { describe, expect, it } from "vitest";
import {
  DEFAULT_COOLDOWN_SECONDS,
  EMPTY_LEDGER,
  MAX_RECONNECT_MINTS_PER_CHAT,
  STABILITY_WINDOW_MS,
  type ReconnectLedger,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
  RECONNECT_GRACE_MS,
  isTerminalMintCode,
  reconnectStep,
  type ReconnectContext,
  type ReconnectEffect,
  type ReconnectInput,
  type Reconnecting,
} from "./reconnect";

const online: ReconnectContext = {
  now: 1_000,
  offline: false,
  ledger: EMPTY_LEDGER,
};
const offline: ReconnectContext = { ...online, offline: true };

/** Runs inputs through the machine; returns the final state and every effect, in order. */
function drive(
  inputs: Array<ReconnectInput | [ReconnectInput, Partial<ReconnectContext>]>,
  start: Reconnecting | null = null,
  startLedger: ReconnectLedger = EMPTY_LEDGER,
) {
  let state = start;
  let ledger = startLedger;
  const effects: ReconnectEffect[] = [];
  const states: Array<Reconnecting | null> = [];
  for (const item of inputs) {
    const [input, ctx] = Array.isArray(item) ? item : [item, {}];
    const step = reconnectStep(state, input, { ...online, ledger, ...ctx });
    state = step.state;
    ledger = step.ledger;
    states.push(state);
    effects.push(...step.effects);
  }
  return { state, effects, states, ledger };
}

const types = (effects: ReconnectEffect[]) => effects.map((e) => e.type);

describe("grace", () => {
  it("waits 8 seconds for a dropped link to come back", () => {
    const { state, effects } = drive([{ type: "link-lost" }]);
    expect(state).toMatchObject({ phase: "grace", attempt: 0, maxAttempts: 3 });
    expect(effects).toEqual([{ type: "start-timer", ms: 8_000 }]);
    expect(RECONNECT_GRACE_MS).toBe(8_000);
  });

  it("recovers on its own with no mint and no new session", () => {
    const { state, effects } = drive([
      { type: "link-lost" },
      { type: "link-recovered" },
    ]);
    expect(state).toBeNull();
    expect(types(effects)).toEqual(["start-timer", "clear-timer", "recovered"]);
    expect(types(effects)).not.toContain("mint");
  });

  it("starts attempt 1 when the grace period runs out", () => {
    const { state, effects } = drive([
      { type: "link-lost" },
      { type: "timer" },
    ]);
    expect(state).toMatchObject({ phase: "minting", attempt: 1 });
    expect(types(effects)).toEqual([
      "start-timer",
      "clear-timer",
      "close-transport",
      "settle-items",
      "mint",
    ]);
  });

  it("starts at once when the link fails during grace", () => {
    const { state } = drive([
      { type: "link-lost" },
      { type: "link-dead", cause: "failed" },
    ]);
    expect(state).toMatchObject({ phase: "minting", attempt: 1 });
  });

  it("keeps the time the trouble began", () => {
    const first = reconnectStep(
      null,
      { type: "link-lost" },
      { now: 5, offline: false, ledger: EMPTY_LEDGER },
    );
    const next = reconnectStep(
      first.state,
      { type: "timer" },
      { now: 9_000, offline: false, ledger: EMPTY_LEDGER },
    );
    expect(next.state?.since).toBe(5);
  });
});

describe("a link that is dead at once", () => {
  it.each(["failed", "session-expired"] as const)(
    "%s goes straight to a mint, without grace",
    (cause) => {
      const { state, effects } = drive([{ type: "link-dead", cause }]);
      expect(state).toMatchObject({ phase: "minting", attempt: 1 });
      expect(types(effects)).toContain("close-transport");
      expect(types(effects)).toContain("mint");
    },
  );

  it("ignores stray link events while a new session is being built", () => {
    const { state } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "link-lost" },
      { type: "link-recovered" },
      { type: "link-dead", cause: "failed" },
      { type: "online" },
      { type: "timer" },
    ]);
    expect(state).toMatchObject({ phase: "minting", attempt: 1 });
  });

  it("ignores everything else while live", () => {
    const inputs: ReconnectInput[] = [
      { type: "link-recovered" },
      { type: "online" },
      { type: "timer" },
      { type: "mint-ok" },
      { type: "mint-error", code: "internal" },
      { type: "connect-ok" },
      { type: "connect-error", kind: "network" },
    ];
    for (const input of inputs) {
      const step = reconnectStep(null, input, online);
      expect(step).toEqual({
        state: null,
        effects: [],
        ledger: EMPTY_LEDGER,
      });
    }
  });
});

describe("a full reconnect", () => {
  it("mints once, connects once and is live again", () => {
    const { state, effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-ok" },
      { type: "connect-ok" },
    ]);
    expect(state).toBeNull();
    expect(effects.filter((e) => e.type === "mint")).toHaveLength(1);
    expect(effects.filter((e) => e.type === "connect")).toHaveLength(1);
    expect(effects.at(-1)).toEqual({ type: "recovered" });
  });

  it("shows connecting between the mint and the connect", () => {
    const { states } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-ok" },
    ]);
    expect(states.at(-1)).toMatchObject({ phase: "connecting", attempt: 1 });
  });
});

describe("attempts and backoff", () => {
  it("waits 0, 2 and 4 seconds before attempts 1, 2 and 3", () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([0, 2_000, 4_000]);
    expect(MAX_RECONNECT_ATTEMPTS).toBe(3);

    const first = drive([{ type: "link-dead", cause: "failed" }]);
    expect(first.state).toMatchObject({ phase: "minting", attempt: 1 });

    const second = drive(
      [{ type: "connect-error", kind: "network" }],
      first.state && { ...first.state, phase: "connecting" },
    );
    expect(second.state).toMatchObject({ phase: "backoff", attempt: 2 });
    expect(second.effects).toContainEqual({ type: "start-timer", ms: 2_000 });

    const resumed = drive([{ type: "timer" }], second.state);
    expect(resumed.state).toMatchObject({ phase: "minting", attempt: 2 });
    expect(types(resumed.effects)).toEqual(["mint"]);

    const third = drive(
      [{ type: "mint-error", code: "internal" }],
      resumed.state,
    );
    expect(third.state).toMatchObject({ phase: "backoff", attempt: 3 });
    expect(third.effects).toContainEqual({ type: "start-timer", ms: 4_000 });
  });

  it("gives up after three failed attempts, with the Connection lost code", () => {
    const { state, effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "internal" },
      { type: "timer" },
      { type: "mint-error", code: "session_connect_failed" },
      { type: "timer" },
      { type: "mint-ok" },
      { type: "connect-error", kind: "timeout" },
    ]);
    expect(state).toBeNull();
    expect(effects.filter((e) => e.type === "mint")).toHaveLength(3);
    expect(effects.at(-1)).toEqual({
      type: "fail",
      code: "session_reconnect_failed",
    });
  });

  it.each(["network", "rejected", "busy", "timeout", "unsupported"] as const)(
    "a %s connect error uses up the attempt and tries again",
    (kind) => {
      const { state } = drive([
        { type: "link-dead", cause: "failed" },
        { type: "mint-ok" },
        { type: "connect-error", kind },
      ]);
      expect(state).toMatchObject({ attempt: 2 });
    },
  );

  it("treats an aborted connect as the caller's doing, not a failure", () => {
    const { state, effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-ok" },
      { type: "connect-error", kind: "aborted" },
    ]);
    expect(state).toMatchObject({ phase: "connecting", attempt: 1 });
    expect(types(effects)).not.toContain("fail");
  });

  it("never retries a billing error at connect", () => {
    const { state, effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-ok" },
      { type: "connect-error", kind: "budget" },
    ]);
    expect(state).toBeNull();
    expect(effects.at(-1)).toEqual({ type: "fail", code: "budget_exhausted" });
  });
});

describe("while offline", () => {
  it("waits for the network, and a wait does not use up an attempt", () => {
    const { state, effects } = drive([
      [{ type: "link-dead", cause: "failed" }, offline],
    ]);
    expect(state).toMatchObject({ phase: "waitingNetwork", attempt: 1 });
    expect(types(effects)).toContain("wait-online");
    expect(types(effects)).not.toContain("mint");
  });

  it("mints the same attempt once the network is back", () => {
    const { state, effects } = drive([
      [{ type: "link-dead", cause: "failed" }, offline],
      { type: "online" },
    ]);
    expect(state).toMatchObject({ phase: "minting", attempt: 1 });
    expect(effects.filter((e) => e.type === "mint")).toHaveLength(1);
  });

  it("goes offline from grace too: no mint while the device has no link", () => {
    const { state, effects } = drive([
      { type: "link-lost" },
      [{ type: "timer" }, offline],
    ]);
    expect(state).toMatchObject({ phase: "waitingNetwork", attempt: 1 });
    expect(types(effects)).not.toContain("mint");
  });

  it("stays put on anything but the network coming back", () => {
    const start = drive([
      [{ type: "link-dead", cause: "failed" }, offline],
    ]).state;
    const { state } = drive(
      [{ type: "timer" }, { type: "link-recovered" }, { type: "mint-ok" }],
      start,
    );
    expect(state).toEqual(start);
  });

  it("a mint nobody answered uses its attempt, then waits for the network", () => {
    const { state } = drive([
      { type: "link-dead", cause: "failed" },
      [{ type: "mint-error", code: "session_network_failed" }, offline],
    ]);
    expect(state).toMatchObject({ phase: "waitingNetwork", attempt: 2 });
  });

  it("still ends after three attempts, however often the network flaps", () => {
    const { state, effects } = drive([
      [{ type: "link-dead", cause: "failed" }, online],
      [{ type: "mint-error", code: "session_network_failed" }, offline],
      { type: "online" },
      { type: "timer" },
      [{ type: "mint-error", code: "session_network_failed" }, offline],
      { type: "online" },
      { type: "timer" },
      [{ type: "mint-error", code: "session_network_failed" }, offline],
    ]);
    expect(state).toBeNull();
    expect(effects.filter((e) => e.type === "mint")).toHaveLength(3);
    expect(effects.at(-1)).toEqual({
      type: "fail",
      code: "session_reconnect_failed",
    });
  });
});

describe("a 429 in the middle of a reconnect", () => {
  it("goes to cooldown for exactly the wait the server gave", () => {
    const { state, effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 42 },
    ]);
    expect(state).toMatchObject({
      phase: "cooldown",
      attempt: 1,
      retryAt: online.now + 42_000,
    });
    expect(effects.at(-1)).toEqual({ type: "start-timer", ms: 42_000 });
  });

  it("falls back to a fixed wait when the server gave none", () => {
    const { state } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "rate_limited" },
    ]);
    expect(state?.retryAt).toBe(online.now + DEFAULT_COOLDOWN_SECONDS * 1000);
  });

  it("resumes at 0 with exactly one mint, with no backoff on top", () => {
    const { state, effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 10 },
      { type: "timer" },
    ]);
    expect(state).toMatchObject({ phase: "minting", attempt: 2 });
    expect(effects.filter((e) => e.type === "mint")).toHaveLength(2);
    // The cooldown was the wait: no second timer after it.
    expect(effects.filter((e) => e.type === "start-timer")).toHaveLength(1);
  });

  it("does nothing while the cooldown runs", () => {
    const start = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 10 },
    ]).state;
    const { state, effects } = drive(
      [
        { type: "link-lost" },
        { type: "online" },
        { type: "mint-ok" },
        { type: "link-dead", cause: "failed" },
      ],
      start,
    );
    expect(state).toEqual(start);
    expect(effects).toEqual([]);
  });

  it("can never become a loop: three 429s are three attempts, then the cooldown card", () => {
    const { state, effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 5 },
      { type: "timer" },
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 5 },
      { type: "timer" },
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 7 },
    ]);
    expect(state).toBeNull();
    expect(effects.filter((e) => e.type === "mint")).toHaveLength(3);
    expect(effects.at(-1)).toEqual({
      type: "fail",
      code: "rate_limited",
      retryAfterSeconds: 7,
    });
  });
});

describe("errors that must never reconnect", () => {
  it.each(["voice_disabled", "daily_limit", "budget_exhausted"] as const)(
    "%s ends the chat with its own code and mints nothing more",
    (code) => {
      const { state, effects } = drive([
        { type: "link-dead", cause: "failed" },
        { type: "mint-error", code },
      ]);
      expect(state).toBeNull();
      expect(effects.filter((e) => e.type === "mint")).toHaveLength(1);
      expect(effects.at(-1)).toEqual({ type: "fail", code });
    },
  );

  it("an expired document ends the chat, so the screen can offer to load it again", () => {
    const { effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "doc_not_found" },
    ]);
    expect(effects.at(-1)).toEqual({ type: "fail", code: "doc_not_found" });
  });

  it("carries the wait of a daily limit to the failure card", () => {
    const { effects } = drive([
      { type: "link-dead", cause: "failed" },
      { type: "mint-error", code: "daily_limit", retryAfterSeconds: 3600 },
    ]);
    expect(effects.at(-1)).toEqual({
      type: "fail",
      code: "daily_limit",
      retryAfterSeconds: 3600,
    });
  });

  it("knows which codes are terminal", () => {
    expect(isTerminalMintCode("daily_limit")).toBe(true);
    expect(isTerminalMintCode("rate_limited")).toBe(false);
    expect(isTerminalMintCode("internal")).toBe(false);
    expect(isTerminalMintCode("session_network_failed")).toBe(false);
  });
});

describe("inputs that do not belong to the current step are ignored", () => {
  const inputs: ReconnectInput[] = [
    { type: "link-lost" },
    { type: "link-recovered" },
    { type: "link-dead", cause: "failed" },
    { type: "online" },
    { type: "timer" },
    { type: "mint-ok" },
    { type: "mint-error", code: "internal" },
    { type: "connect-ok" },
    { type: "connect-error", kind: "network" },
  ];
  // Which input each phase acts on; every other one must change nothing.
  const acts: Record<Reconnecting["phase"], ReconnectInput["type"][]> = {
    grace: ["link-recovered", "timer", "link-dead"],
    waitingNetwork: ["online"],
    backoff: ["timer"],
    minting: ["mint-ok", "mint-error"],
    connecting: ["connect-ok", "connect-error"],
    cooldown: ["timer"],
  };
  const phases = Object.keys(acts) as Reconnecting["phase"][];

  it.each(phases)("%s", (phase) => {
    const state: Reconnecting = {
      status: "reconnecting",
      since: 1,
      phase,
      attempt: 1,
      maxAttempts: 3,
    };
    for (const input of inputs) {
      if (acts[phase].includes(input.type)) continue;
      expect(reconnectStep(state, input, online)).toEqual({
        state,
        effects: [],
        ledger: EMPTY_LEDGER,
      });
    }
  });
});

describe("a link that keeps coming back and dropping", () => {
  const dead = { type: "link-dead", cause: "failed" } as const;
  /** One outage that is rebuilt on its first attempt: dead, mint, connect. */
  const rebuilt = (
    at: number,
  ): Array<ReconnectInput | [ReconnectInput, Partial<ReconnectContext>]> => [
    [dead, { now: at }],
    [{ type: "mint-ok" }, { now: at }],
    [{ type: "connect-ok" }, { now: at + 100 }],
  ];
  const mintsIn = (effects: ReconnectEffect[]) =>
    effects.filter((e) => e.type === "mint").length;

  it("carries the attempt count across drops inside the stability window", () => {
    // Up at t=1000 (attempt 1). Dropped again 5 s later: that is attempt 2, with backoff.
    const first = drive(rebuilt(1_000));
    expect(first.ledger).toMatchObject({ stableFrom: 1_100, lastAttempt: 1 });

    const second = drive([[dead, { now: 6_000 }]], null, first.ledger);
    expect(second.state).toMatchObject({ phase: "backoff", attempt: 2 });
    expect(second.effects).toContainEqual({ type: "start-timer", ms: 2_000 });
  });

  it("gives up after three rebuilds that each fail to hold, instead of minting forever", () => {
    let ledger = EMPTY_LEDGER;
    let mints = 0;
    let state: Reconnecting | null = null;
    let at = 1_000;
    let last: ReconnectEffect | undefined;
    // A link that connects, then drops 2 s later, again and again.
    for (let i = 0; i < 20 && !last; i++) {
      for (const input of [
        dead,
        { type: "timer" } as const,
        { type: "mint-ok" } as const,
        { type: "connect-ok" } as const,
      ]) {
        const step = reconnectStep(state, input, {
          now: at,
          offline: false,
          ledger,
        });
        state = step.state;
        ledger = step.ledger;
        mints += mintsIn(step.effects);
        last = step.effects.find((e) => e.type === "fail");
        if (last) break;
      }
      at += 2_000;
    }
    expect(last).toEqual({ type: "fail", code: "session_reconnect_failed" });
    // Attempts 1, 2 and 3, and not one more.
    expect(mints).toBe(MAX_RECONNECT_ATTEMPTS);
  });

  it("starts over at attempt 1 once the new session has stayed up for the window", () => {
    const first = drive(rebuilt(1_000));
    const later = 1_100 + STABILITY_WINDOW_MS;
    const second = drive([[dead, { now: later }]], null, first.ledger);
    expect(second.state).toMatchObject({ phase: "minting", attempt: 1 });
  });

  it("still counts a drop one millisecond inside the window as the same outage", () => {
    const first = drive(rebuilt(1_000));
    const second = drive(
      [[dead, { now: 1_100 + STABILITY_WINDOW_MS - 1 }]],
      null,
      first.ledger,
    );
    expect(second.state).toMatchObject({ attempt: 2 });
  });

  it("a link that heals inside grace spends nothing and leaves the window alone", () => {
    const first = drive(rebuilt(1_000));
    const healed = drive(
      [
        [{ type: "link-lost" }, { now: 5_000 }],
        [{ type: "link-recovered" }, { now: 6_000 }],
      ],
      null,
      first.ledger,
    );
    expect(healed.ledger).toEqual(first.ledger);
    expect(mintsIn(healed.effects)).toBe(0);
  });

  it("caps the chat at six reconnect mints however stable the link was in between", () => {
    let ledger = EMPTY_LEDGER;
    let at = 1_000;
    let minted = 0;
    let failed: ReconnectEffect | undefined;
    for (let outage = 0; outage < 12 && !failed; outage++) {
      const run = drive(rebuilt(at), null, ledger);
      minted += mintsIn(run.effects);
      failed = run.effects.find((e) => e.type === "fail");
      ledger = run.ledger;
      // Stable for longer than the window, so the attempt count starts over each time.
      at += STABILITY_WINDOW_MS + 5_000;
    }
    expect(minted).toBe(MAX_RECONNECT_MINTS_PER_CHAT);
    expect(failed).toEqual({ type: "fail", code: "session_reconnect_failed" });
    expect(ledger.mints).toBe(MAX_RECONNECT_MINTS_PER_CHAT);
  });

  it("counts a mint when it starts, whichever road led to it", () => {
    // Immediate, after backoff, after a cooldown, after waiting for the network.
    const viaBackoff = drive([
      dead,
      { type: "mint-error", code: "internal" },
      { type: "timer" },
    ]);
    expect(viaBackoff.ledger.mints).toBe(2);

    const viaCooldown = drive([
      dead,
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 5 },
      { type: "timer" },
    ]);
    expect(viaCooldown.ledger.mints).toBe(2);

    const viaNetwork = drive([[dead, { offline: true }], { type: "online" }]);
    expect(viaNetwork.ledger.mints).toBe(1);
  });

  it("refuses to mint once the chat's budget is spent, on every road into minting", () => {
    const spent = { ...EMPTY_LEDGER, mints: MAX_RECONNECT_MINTS_PER_CHAT };
    const direct = drive([dead], null, spent);
    expect(direct.effects.at(-1)).toEqual({
      type: "fail",
      code: "session_reconnect_failed",
    });
    expect(mintsIn(direct.effects)).toBe(0);

    // Budget runs out between an attempt starting and its backoff ending.
    const inBackoff: Reconnecting = {
      status: "reconnecting",
      since: 1,
      phase: "backoff",
      attempt: 2,
      maxAttempts: 3,
    };
    const afterBackoff = drive([{ type: "timer" }], inBackoff, spent);
    expect(afterBackoff.effects.at(-1)).toEqual({
      type: "fail",
      code: "session_reconnect_failed",
    });
    expect(mintsIn(afterBackoff.effects)).toBe(0);

    const waiting: Reconnecting = { ...inBackoff, phase: "waitingNetwork" };
    const afterNetwork = drive([{ type: "online" }], waiting, spent);
    expect(afterNetwork.effects.at(-1)).toEqual({
      type: "fail",
      code: "session_reconnect_failed",
    });
  });

  it("a cooldown that then waited for the network does not add a backoff on top", () => {
    const { state, effects } = drive([
      dead,
      { type: "mint-error", code: "rate_limited", retryAfterSeconds: 5 },
      [{ type: "timer" }, { offline: true }],
      { type: "online" },
    ]);
    expect(state).toMatchObject({ phase: "minting", attempt: 2 });
    expect(effects.filter((e) => e.type === "start-timer")).toHaveLength(1);
  });
});
