import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeHarness,
  type Harness,
  type HarnessOptions,
} from "@test/realtime/harness";
import { transcript } from "@test/realtime/script";
import { ev } from "./wire-events";
import { MintError } from "./mint";
import { scenarioScript } from "./mock-scenarios";
import { MockTransport } from "./mock-transport";
import type { LevelMeter } from "./levels";
import {
  CAP_WARNING_MS,
  HIDDEN_MS,
  IDLE_MS,
  MIC_RETRY_MIN_MS,
  RECONNECT_GRACE_MS,
  failureForTransportError,
} from "./session";
import { TransportError } from "./transport";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = (ms = 1) => vi.advanceTimersByTimeAsync(ms);

async function started(
  mode: "voice" | "text" = "voice",
  options: HarnessOptions = {},
): Promise<Harness> {
  const h = makeHarness(options);
  h.session.start(mode);
  await settle(50);
  return h;
}

const status = (h: Harness) => h.session.getState().connection.status;
const sentTypes = (h: Harness) => h.transport.sent.map((e) => e.type);

describe("starting a chat", () => {
  it("does everything the browser needs from the tap before its first await", () => {
    const h = makeHarness();
    h.session.start("voice");
    // Same tick: nothing has been awaited yet.
    expect(h.requestMic).toHaveBeenCalledOnce();
    expect(h.deps.createAudioElement).toHaveBeenCalledOnce();
    expect(h.deps.createAudioContext).toHaveBeenCalledOnce();
    expect(status(h)).toBe("requestingMic");
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("walks requestingMic → minting → negotiating → connected with the mic", async () => {
    const h = makeHarness({ script: { connectDelayMs: 100, steps: [] } });
    const seen: string[] = [];
    h.session.subscribe(() => {
      const c = h.session.getState().connection;
      const label =
        c.status === "connecting" ? `connecting:${c.phase}` : c.status;
      if (label !== "idle" && seen.at(-1) !== label) seen.push(label);
    });
    h.session.start("voice");
    await settle(50);
    expect(status(h)).toBe("connecting");
    await settle(100);

    expect(seen).toEqual([
      "requestingMic",
      "connecting:minting",
      "connecting:negotiating",
      "connected",
    ]);
    expect(h.mint).toHaveBeenCalledWith("doc-1", expect.any(AbortSignal), []);
    expect(h.transport.lastConnect?.clientSecret).toBe(h.response.clientSecret);
    expect(h.transport.lastConnect?.micStream).toBe(h.micStreams[0]);
    expect(h.session.model).toBe("gpt-realtime-2.1-mini");
    expect(h.session.maxSessionSeconds).toBe(300);
    expect(h.session.getState().mode).toBe("voice");
  });

  it("starts in text mode without asking for the mic", async () => {
    const h = await started("text");
    expect(h.requestMic).not.toHaveBeenCalled();
    expect(status(h)).toBe("connected");
    expect(h.transport.lastConnect?.micStream).toBeNull();
    expect(h.session.getState().mode).toBe("text");
  });

  it.each([
    "denied",
    "not_found",
    "in_use",
    "insecure",
    "unsupported",
    "unavailable",
  ] as const)(
    "falls back to text mode when the mic fails (%s)",
    async (reason) => {
      const h = await started("voice", { mic: reason });
      const s = h.session.getState();
      expect(s.connection.status).toBe("connected");
      expect(s.mode).toBe("text");
      expect(s.micIssue).toBe(reason);
      expect(h.transport.lastConnect?.micStream).toBeNull();
    },
  );

  it("ignores a second tap while a start is under way", async () => {
    const h = makeHarness();
    h.session.start("voice");
    h.session.start("voice");
    h.session.start("text");
    await settle(50);
    expect(h.requestMic).toHaveBeenCalledOnce();
    expect(h.transports).toHaveLength(1);
    h.session.start("voice");
    expect(h.requestMic).toHaveBeenCalledOnce();
  });

  it("can start again after the chat ended, with a clean transcript", async () => {
    const h = await started("text", { script: scenarioScript("text-turn") });
    h.session.sendText("First?");
    await settle(1000);
    expect(h.session.getState().order).toHaveLength(2);
    h.session.end();
    expect(status(h)).toBe("ended");
    expect(h.session.getState().order).toHaveLength(2); // kept on screen

    h.session.start("text");
    expect(h.session.getState().order).toEqual([]);
    await settle(50);
    expect(status(h)).toBe("connected");
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]?.closeCount).toBe(1);
  });

  it("plays server events into the transcript", async () => {
    const h = makeHarness({ script: scenarioScript("normal-turn") });
    h.session.start("voice");
    await settle(6000);
    expect(transcript(h.session.getState())).toEqual([
      ["user", "done", "What was revenue?"],
      ["assistant", "done", "Revenue grew twelve percent last year."],
    ]);
    expect(h.session.getState().activity).toBe("listening");
  });
});

describe("failing to start", () => {
  it.each([
    [new MintError("voice_disabled"), "voice_disabled"],
    [new MintError("daily_limit"), "daily_limit"],
    [new MintError("budget_exhausted"), "budget_exhausted"],
    [new MintError("rate_limited"), "rate_limited"],
    [new Error("boom"), "session_connect_failed"],
  ])(
    "maps a mint failure (%s) to %s and gives everything back",
    async (error, code) => {
      const h = await started("voice", { mintError: error });
      expect(h.session.getState().connection).toEqual({
        status: "failed",
        code,
      });
      expect(h.createTransport).not.toHaveBeenCalled();
      h.expectAllReleased();
    },
  );

  it.each([
    ["busy", "session_upstream_busy"],
    ["budget", "budget_exhausted"],
    ["timeout", "session_connect_failed"],
    ["rejected", "session_connect_failed"],
    ["network", "session_network_failed"],
    ["unsupported", "session_connect_failed"],
  ] as const)("maps a %s connect failure to %s", async (kind, code) => {
    const h = await started("voice", { script: { failWith: kind, steps: [] } });
    expect(h.session.getState().connection).toEqual({ status: "failed", code });
    h.expectAllReleased();
  });

  it("keeps the wait from a rate limit in the failed state", async () => {
    const h = await started("voice", {
      mintError: new MintError("rate_limited", 42),
    });
    const c = h.session.getState().connection;
    expect(c).toMatchObject({
      status: "failed",
      code: "rate_limited",
      retryAfterSeconds: 42,
    });
    // Also a deadline, fixed when the refusal arrived, so a countdown reads
    // the clock instead of counting ticks. (The helper lets ~50 ms pass.)
    const retryAt = c.status === "failed" ? (c.retryAt ?? 0) : 0;
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 42_000);
    expect(retryAt).toBeGreaterThan(Date.now() + 41_000);
    h.expectAllReleased();
  });

  it("has no retryAfterSeconds on failures that gave none", async () => {
    const h = await started("voice", {
      mintError: new MintError("daily_limit"),
    });
    expect(h.session.getState().connection).not.toHaveProperty(
      "retryAfterSeconds",
    );
    expect(h.session.getState().connection).not.toHaveProperty("retryAt");
  });

  it("fails cleanly when no transport can be built", async () => {
    const h = await started("voice", {
      transportError: new TransportError("unsupported"),
    });
    expect(h.session.getState().connection).toEqual({
      status: "failed",
      code: "session_connect_failed",
    });
    h.expectAllReleased();
  });

  it("maps transport errors, treating an abort as 'not a failure'", () => {
    expect(failureForTransportError(new TransportError("aborted"))).toBeNull();
    expect(failureForTransportError(new Error("x"))).toBe(
      "session_connect_failed",
    );
  });

  it("calls an ICE failure a failed connection, and only an unanswered request offline", () => {
    expect(failureForTransportError(new TransportError("media"))).toBe(
      "session_connect_failed",
    );
    expect(failureForTransportError(new TransportError("network"))).toBe(
      "session_network_failed",
    );
  });

  it("can try again after a failure", async () => {
    const h = await started("voice", {
      mintError: new MintError("rate_limited"),
    });
    expect(status(h)).toBe("failed");
    h.session.start("voice");
    expect(status(h)).toBe("requestingMic");
  });
});

describe("ending at any point", () => {
  it("while the mic prompt is open: stops the mic that arrives later, never mints", async () => {
    const h = makeHarness({ mic: "pending" });
    h.session.start("voice");
    await settle(10);
    h.session.end();
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "user",
    });
    const stream = h.resolveMic();
    await settle(50);
    expect(stream.tracks[0]?.stop).toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    h.expectAllReleased();
  });

  it("while minting: never opens a transport, releases the mic", async () => {
    const h = makeHarness({ mintError: "pending" });
    h.session.start("voice");
    await settle(10);
    expect(h.mint).toHaveBeenCalled();
    h.session.end();
    h.resolveMint();
    await settle(50);
    expect(h.createTransport).not.toHaveBeenCalled();
    expect(status(h)).toBe("ended");
    h.expectAllReleased();
  });

  it("aborts the mint request", async () => {
    const h = makeHarness({ mintError: "pending" });
    h.session.start("text");
    await settle(10);
    const signal = h.mint.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    h.session.end();
    expect(signal?.aborted).toBe(true);
  });

  it("while the transport is being built: closes it as soon as it exists", async () => {
    const h = makeHarness();
    h.deps.createTransport = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 500));
      const t = new MockTransport({ connectDelayMs: 0, steps: [] });
      h.transports.push(t);
      return t;
    });
    h.session.start("voice");
    await settle(100);
    h.session.end();
    await settle(1000);
    expect(h.transports).toHaveLength(1);
    expect(h.transport.closeCount).toBe(1);
    expect(status(h)).toBe("ended");
    h.expectAllReleased();
  });

  it("while connecting: closes the transport, never reaches connected", async () => {
    const h = makeHarness({ script: { connectDelayMs: 5000, steps: [] } });
    h.session.start("voice");
    await settle(100);
    expect(status(h)).toBe("connecting");
    h.session.end();
    await settle(10_000);
    expect(status(h)).toBe("ended");
    expect(h.transport.closeCount).toBe(1);
    h.expectAllReleased();
  });

  it("while connected: releases tracks, connection, audio, meter and timers", async () => {
    const h = await started("voice");
    h.session.subscribeLevel("mic", () => {});
    expect(h.meters[0]?.running).toBe(true);
    h.session.end();
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "user",
    });
    h.expectAllReleased();
  });

  it("is harmless when called repeatedly, or before a start", async () => {
    const idle = makeHarness();
    idle.session.end();
    idle.session.detach();
    expect(idle.session.getState().connection.status).toBe("idle");

    const h = await started("voice");
    h.session.end();
    h.session.end();
    h.session.detach();
    expect(h.transport.closeCount).toBe(1);
    h.expectAllReleased();
  });

  it("detach (unmount) ends a live chat and frees a half-started one", async () => {
    const live = await started("voice");
    live.session.detach();
    expect(live.session.getState().connection.status).toBe("ended");
    live.expectAllReleased();

    const half = makeHarness({ mic: "pending" });
    half.session.start("voice");
    half.session.detach();
    half.resolveMic();
    await settle(50);
    half.expectAllReleased();
  });

  it("leaks nothing over 20 start/end cycles, ending at different points", async () => {
    const h = makeHarness({ script: { connectDelayMs: 40, steps: [] } });
    const endAt = [0, 5, 20, 60, 200];
    for (let i = 0; i < 20; i++) {
      h.session.start(i % 2 === 0 ? "voice" : "text");
      await settle(endAt[i % endAt.length] ?? 0);
      if (i % 4 === 3) h.session.subscribeLevel("mic", () => {})();
      h.session.end();
      await settle(300);
      expect(["ended", "failed"]).toContain(status(h));
    }
    expect(h.deps.createAudioContext).toHaveBeenCalledTimes(20);
    expect(h.contexts).toHaveLength(20);
    expect(h.meters).toHaveLength(20);
    h.expectAllReleased();
  });
});

describe("something unexpected inside the start-up", () => {
  it("fails the chat instead of leaving it stuck on connecting", async () => {
    const h = makeHarness();
    // A meter that throws: an error nobody planned for, inside the async run.
    h.deps.createLevelMeter = vi.fn(
      () =>
        ({
          attach: () => {
            throw new Error("boom");
          },
          subscribe: () => () => {},
          dispose: () => {},
          running: false,
        }) as unknown as LevelMeter,
    );
    h.session.start("voice");
    await settle(100);
    expect(h.session.getState().connection).toEqual({
      status: "failed",
      code: "session_connect_failed",
    });
    expect(h.micStreams[0]?.tracks[0]?.readyState).toBe("ended");
    expect(h.transports).toHaveLength(0);
  });
});

describe("the microphone disappears mid-chat", () => {
  it("carries on as a text chat, with the mic reason and no stuck 'muted', when it cannot be had again", async () => {
    const h = await started("voice");
    h.session.setMuted(true);
    h.setMic("unavailable");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);

    const s = h.session.getState();
    expect(s.connection.status).toBe("connected");
    expect(s.mode).toBe("text");
    expect(s.micIssue).toBe("unavailable");
    expect(s.muted).toBe(false);
    // Asking again costs no new secret.
    expect(h.mint).toHaveBeenCalledOnce();

    // Typed questions now ask for text replies, like any text chat.
    h.transport.sent.length = 0;
    h.session.sendText("Still there?");
    expect(h.transport.sent[1]).toMatchObject({
      type: "response.create",
      response: { output_modalities: ["text"] },
    });
  });

  it("is handled while still connecting", async () => {
    const h = makeHarness({ script: { connectDelayMs: 500, steps: [] } });
    h.session.start("voice");
    await settle(100);
    expect(h.session.getState().connection.status).toBe("connecting");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    // The connection was offered the dead track and cannot take another yet.
    expect(h.session.getState().mode).toBe("text");
    await settle(600);
    expect(h.session.getState().connection.status).toBe("connected");
  });

  it("stops listening when the chat ends, so a late 'ended' does nothing", async () => {
    const h = await started("voice");
    const track = h.micStreams[0]?.tracks[0];
    expect(track?.listenerCount("ended")).toBe(1);
    h.session.end();
    expect(track?.listenerCount("ended")).toBe(0);
    const before = h.session.getState();
    track?.end();
    expect(h.session.getState()).toBe(before);
  });

  it("ignores it in a chat that was already text-only", async () => {
    const h = await started("voice", { mic: "denied" });
    const before = h.session.getState();
    expect(before.mode).toBe("text");
    expect(before.micIssue).toBe("denied"); // the original reason is kept
  });
});

describe("turning the microphone on in a text chat", () => {
  // The session never calls fetch itself (mint and transport are injected),
  // so any call here would be a request the retry flow must not make.
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A voice start whose mic was refused: connected, in text mode, banner up. */
  async function deniedChat(options: HarnessOptions = {}): Promise<Harness> {
    const h = await started("voice", { mic: "denied", ...options });
    expect(status(h)).toBe("connected");
    expect(h.session.getState().mode).toBe("text");
    expect(h.mint).toHaveBeenCalledOnce();
    h.requestMic.mockClear();
    return h;
  }

  /** Everything a retry that found no mic must leave untouched. */
  function expectNoNetwork(h: Harness) {
    expect(h.mint).toHaveBeenCalledOnce(); // the chat's own secret, nothing since
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.createTransport).toHaveBeenCalledOnce();
    expect(h.transports).toHaveLength(1);
    expect(h.transport.micUpgrades).toEqual([]);
    expect(h.transport.sent).toEqual([]);
    expect(h.transport.closeCount).toBe(0);
    expect(status(h)).toBe("connected");
    expect(h.session.getState().mode).toBe("text");
  }

  it("stops at the permission check when the browser says denied: no getUserMedia, no API call", async () => {
    const h = await deniedChat();
    // Even a mic that would work is not asked for: the browser said no.
    h.setMic("ok", "denied");

    h.session.enableMic();
    expect(h.session.getState().micRetry).toBe("working");
    await settle();

    expect(h.queryMicPermission).toHaveBeenCalledOnce();
    expect(h.requestMic).not.toHaveBeenCalled();
    expectNoNetwork(h);
    const s = h.session.getState();
    expect(s.micIssue).toBe("denied");
    expect(s.micRetry).toBe("idle"); // the button is usable again
    expect(s.micRetryFails).toBe(1);
  });

  it.each([
    ["denied", "NotAllowedError"],
    ["not_found", "NotFoundError"],
    ["in_use", "NotReadableError"],
  ] as const)(
    "getUserMedia fails with %s (%s): the reason is shown and nothing is requested",
    async (reason, errorName) => {
      void errorName; // only in the test's name: mic.test.ts maps names to reasons
      const h = await deniedChat();
      h.setMic(reason, "prompt");

      h.session.enableMic();
      await settle();

      expect(h.requestMic).toHaveBeenCalledOnce();
      expectNoNetwork(h);
      const s = h.session.getState();
      expect(s.micIssue).toBe(reason);
      expect(s.micRetry).toBe("idle");
      expect(s.micRetryFails).toBe(1);
    },
  );

  it("can be tapped again and again without ever minting a secret", async () => {
    const h = await deniedChat();
    h.setMic("denied", "unknown");
    for (let i = 0; i < 8; i += 1) {
      h.session.enableMic();
      await settle(MIC_RETRY_MIN_MS);
    }
    expect(h.requestMic).toHaveBeenCalledTimes(8);
    expect(h.session.getState().micRetryFails).toBe(8);
    expectNoNetwork(h);
  });

  it("debounces: taps under a second apart count once, and a tap while checking is ignored", async () => {
    const h = await deniedChat();
    h.setMic("denied", "prompt");

    h.session.enableMic();
    h.session.enableMic(); // same tick: already checking
    await settle();
    expect(h.session.getState().micRetry).toBe("idle");
    h.session.enableMic(); // done checking, but too soon
    await settle(MIC_RETRY_MIN_MS - 10);
    expect(h.queryMicPermission).toHaveBeenCalledOnce();
    expect(h.requestMic).toHaveBeenCalledOnce();

    await settle(10);
    h.session.enableMic();
    await settle();
    expect(h.requestMic).toHaveBeenCalledTimes(2);

    // A permission prompt left open keeps the check running for as long as
    // it takes; taps in the meantime do not stack up more prompts.
    h.setMic("pending", "prompt");
    await settle(MIC_RETRY_MIN_MS);
    h.session.enableMic();
    await settle(5 * MIC_RETRY_MIN_MS);
    expect(h.session.getState().micRetry).toBe("working");
    h.session.enableMic();
    await settle();
    expect(h.requestMic).toHaveBeenCalledTimes(3);
    expectNoNetwork(h);

    h.session.end();
    h.resolveMic();
    await settle();
    h.expectAllReleased();
  });

  it("upgrades in place when the mic works: same connection, same secret, transcript kept", async () => {
    const h = await deniedChat({ script: scenarioScript("text-turn") });
    h.session.sendText("What is this about?");
    await settle(1500);
    const before = transcript(h.session.getState());
    expect(before).toHaveLength(2);
    h.transport.sent.length = 0;
    h.setMic("ok", "prompt");

    h.session.enableMic();
    await settle();

    const mic = h.micStreams.at(-1);
    expect(h.requestMic).toHaveBeenCalledOnce();
    // The track went into the transport that was already connected...
    expect(h.transport.micUpgrades).toEqual([mic]);
    // ...and nothing else moved: no new secret, no new transport, no request.
    expect(h.mint).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.createTransport).toHaveBeenCalledOnce();
    expect(h.transport.closeCount).toBe(0);
    expect(h.transport.sent).toEqual([]);

    const s = h.session.getState();
    expect(s.connection.status).toBe("connected");
    expect(s.mode).toBe("voice");
    expect(s.micIssue).toBeNull();
    expect(s.micRetry).toBe("idle");
    expect(s.micRetryFails).toBe(0);
    expect(transcript(s)).toEqual(before);

    // It is a real voice chat now: mute works, typed questions get spoken answers.
    h.session.setMuted(true);
    expect(mic?.tracks[0]?.enabled).toBe(false);
    h.session.setMuted(false);
    h.session.sendText("And the margins?");
    expect(h.transport.sent.at(-1)).toEqual({
      type: "response.create",
      event_id: expect.any(String),
    });

    h.session.end();
    h.expectAllReleased();
  });

  it("clears the count of failed retries once a retry works", async () => {
    const h = await deniedChat();
    h.setMic("in_use", "prompt");
    h.session.enableMic();
    await settle(MIC_RETRY_MIN_MS);
    expect(h.session.getState().micRetryFails).toBe(1);

    h.setMic("ok", "granted");
    h.session.enableMic();
    await settle();
    expect(h.session.getState()).toMatchObject({
      mode: "voice",
      micIssue: null,
      micRetryFails: 0,
    });
    expect(h.mint).toHaveBeenCalledOnce();
  });

  it("works the same from a chat that was started as text on purpose", async () => {
    const h = await started("text");
    expect(h.session.getState().micIssue).toBeNull();
    expect(h.transport.lastConnect?.micStream).toBeNull();

    h.session.enableMic();
    await settle();

    expect(h.transport.micUpgrades).toEqual([h.micStreams[0]]);
    expect(h.session.getState().mode).toBe("voice");
    expect(h.mint).toHaveBeenCalledOnce();
    h.session.end();
    h.expectAllReleased();
  });

  it("text mode itself mints exactly one secret per chat", async () => {
    const h = await started("text", { script: scenarioScript("text-turn") });
    h.session.sendText("One");
    await settle(1500);
    h.session.sendText("Two");
    await settle(1500);
    h.setMic("denied", "denied");
    h.session.enableMic();
    await settle(MIC_RETRY_MIN_MS);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to exactly one reconnect with one fresh secret when the track cannot be swapped in", async () => {
    const h = await deniedChat({ script: { steps: [], micUpgrade: "fail" } });
    const first = h.transport;
    h.setMic("ok", "prompt");

    h.session.enableMic();
    await settle(50);

    const mic = h.micStreams.at(-1);
    expect(first.micUpgrades).toEqual([mic]); // the in-place path was tried first
    expect(first.closeCount).toBe(1);
    // One reconnect, one new secret, and only after getUserMedia succeeded.
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The stream already in hand is reused: no second prompt.
    expect(h.requestMic).toHaveBeenCalledOnce();
    expect(h.transport.lastConnect?.micStream).toBe(mic);
    expect(mic?.tracks[0]?.readyState).toBe("live");

    const s = h.session.getState();
    expect(s.connection.status).toBe("connected");
    expect(s.mode).toBe("voice");
    expect(s.micIssue).toBeNull();
    expect(s.micRetry).toBe("idle");

    // Still exactly two after the dust settles: nothing loops.
    await settle(5000);
    expect(h.mint).toHaveBeenCalledTimes(2);
    h.session.end();
    h.expectAllReleased();
  });

  it("keeps the typed turns on screen and gives them to the replacement session as history", async () => {
    const h = await deniedChat({ script: { steps: [], micUpgrade: "fail" } });
    h.session.sendText("What was revenue?");
    await settle(2000);
    const before = h.session.getState();
    const turns = before.order.map((id) => before.items[id]);
    expect(turns.length).toBeGreaterThanOrEqual(2); // the question and its answer
    expect(turns.every((t) => t?.status === "done")).toBe(true);
    h.setMic("ok", "prompt");

    h.session.enableMic();
    await settle(50);

    // The first secret was minted with no history; the second carries the talk.
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.mint.mock.calls[0]?.[2] ?? []).toEqual([]);
    expect(h.mint.mock.calls[1]?.[2]).toEqual(
      turns.map((t) => ({ role: t?.role, text: t?.text })),
    );
    // And nothing vanished from the screen.
    const after = h.session.getState();
    expect(after.connection.status).toBe("connected");
    expect(after.order.slice(0, turns.length)).toEqual(before.order);
    expect(after.items[before.order[0] ?? ""]?.text).toBe("What was revenue?");
    h.session.end();
    h.expectAllReleased();
  });

  it("replaces a mic that died in a chat that began as voice", async () => {
    const h = await started("voice");
    const dead = h.micStreams[0];
    // The automatic re-acquire finds no mic, so the chat drops to text.
    h.setMic("unavailable");
    dead?.tracks[0]?.end();
    await settle(100);
    h.setMic("ok");
    expect(h.session.getState()).toMatchObject({
      mode: "text",
      micIssue: "unavailable",
    });

    h.session.enableMic();
    await settle();

    const fresh = h.micStreams[1];
    expect(dead?.tracks[0]?.stop).toHaveBeenCalled();
    expect(dead?.tracks[0]?.listenerCount("ended")).toBe(0);
    expect(h.transport.micUpgrades).toEqual([fresh]);
    expect(h.session.getState()).toMatchObject({
      mode: "voice",
      micIssue: null,
    });
    expect(h.mint).toHaveBeenCalledOnce();

    // The new mic is watched like the first one was (and again too soon to retry).
    fresh?.tracks[0]?.end();
    await settle(100);
    expect(h.session.getState().mode).toBe("text");
    h.session.end();
    h.expectAllReleased();
  });

  it("unlocks audio output inside the tap, before anything is awaited", async () => {
    const h = await started("text");
    const context = h.contexts[0];
    const element = h.elements[0];
    h.session.enableMic();
    expect(context?.resume).toHaveBeenCalledOnce();
    expect(element?.play).toHaveBeenCalledOnce();
    await settle();
  });

  it("does nothing outside a connected text chat", async () => {
    const idle = makeHarness();
    idle.session.enableMic();

    const connecting = makeHarness({
      script: { connectDelayMs: 500, steps: [] },
    });
    connecting.session.start("text");
    await settle(50);
    connecting.session.enableMic();

    const voice = await started("voice");
    voice.requestMic.mockClear();
    voice.session.enableMic();

    const ended = await started("text");
    ended.session.end();
    ended.session.enableMic();

    await settle();
    for (const h of [idle, connecting, voice, ended]) {
      expect(h.queryMicPermission).not.toHaveBeenCalled();
      expect(h.requestMic).not.toHaveBeenCalled();
      expect(h.session.getState().micRetry).toBe("idle");
    }
    connecting.session.end();
    voice.session.end();
  });

  it("drops everything if the chat ends during the permission check", async () => {
    const h = await deniedChat();
    h.setMic("ok", "prompt");
    let answer: (p: "granted") => void = () => {};
    h.queryMicPermission.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    h.session.enableMic();
    h.session.end();
    expect(h.session.getState().micRetry).toBe("idle");
    answer("granted");
    await settle();
    expect(h.requestMic).not.toHaveBeenCalled();
    h.expectAllReleased();
  });

  it("stops a mic that arrives after the chat ended", async () => {
    const h = await deniedChat();
    h.setMic("pending", "prompt");
    h.session.enableMic();
    await settle();
    h.session.end();
    const late = h.resolveMic();
    await settle();
    expect(late.tracks[0]?.readyState).toBe("ended");
    expect(h.transport.micUpgrades).toEqual([]);
    expect(h.session.getState().mode).toBe("text");
    h.expectAllReleased();
  });

  it("leaves an ended chat alone if it ends while the track is being swapped", async () => {
    const h = await deniedChat();
    h.setMic("ok", "prompt");
    let finish: (ok: boolean) => void = () => {};
    vi.spyOn(h.transport, "upgradeMic").mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    h.session.enableMic();
    await settle();
    h.session.end();
    finish(true);
    await settle();
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "user",
    });
    expect(h.session.getState().mode).toBe("text");
    expect(h.mint).toHaveBeenCalledOnce();
    h.expectAllReleased();
  });

  it("stays a text chat, with the button free, if something unexpected throws", async () => {
    const h = await deniedChat();
    h.queryMicPermission.mockRejectedValueOnce(new Error("boom"));
    h.session.enableMic();
    await settle();
    expect(h.session.getState()).toMatchObject({
      mode: "text",
      micRetry: "idle",
    });
    expectNoNetwork(h);
  });

  it("notes each step in the dev recording", async () => {
    const failing = await deniedChat({ recorder: true });
    failing.setMic("in_use", "prompt");
    failing.session.enableMic();
    await settle();
    const log = failing.recorders[0]?.toJsonl() ?? "";
    expect(log).toContain('"event":"mic_retry"');
    expect(log).toContain('"reason":"in_use"');

    const upgraded = await deniedChat({ recorder: true });
    upgraded.setMic("ok", "prompt");
    upgraded.session.enableMic();
    await settle();
    expect(upgraded.recorders[0]?.toJsonl()).toContain(
      '"event":"mic_upgraded"',
    );

    const restarted = await deniedChat({
      recorder: true,
      script: { steps: [], micUpgrade: "fail" },
    });
    restarted.setMic("ok", "prompt");
    restarted.session.enableMic();
    await settle(50);
    expect(restarted.recorders).toHaveLength(2);
    expect(restarted.recorders[1]?.toJsonl()).toContain(
      '"event":"mic_restart"',
    );
    for (const h of [failing, upgraded, restarted]) h.session.end();
  });
});

describe("stop answer", () => {
  it("cancels, then clears the audio, in that order, and marks the answer interrupted", async () => {
    const h = await started("voice", { script: scenarioScript("normal-turn") });
    await settle(1800); // answer is being spoken
    expect(h.session.getState().activity).toBe("assistantSpeaking");
    h.transport.sent.length = 0;

    h.session.stopAnswer();
    expect(sentTypes(h)).toEqual([
      "response.cancel",
      "output_audio_buffer.clear",
    ]);
    const s = h.session.getState();
    expect(s.activity).toBe("listening");
    expect(transcript(s)[1]?.[1]).toBe("interrupted");
    expect(s.response).toEqual({ activeId: null, audioId: null });
  });

  it("sends only a cancel in text mode: there is no audio to clear", async () => {
    const h = await started("text", {
      script: {
        steps: [],
        replyWith: "text",
        textAnswer: "one two three four five six seven",
      },
    });
    h.session.sendText("Go");
    await settle(200);
    h.transport.sent.length = 0;
    h.session.stopAnswer();
    expect(sentTypes(h)).toEqual(["response.cancel"]);
    await settle(1000);
    const s = h.session.getState();
    expect(s.notice).toBeNull();
    expect(transcript(s)[1]?.[1]).toBe("interrupted");
    expect(s.activity).toBe("listening");
  });

  it("does nothing when nothing is being answered, or when not connected", async () => {
    const h = await started("voice");
    h.transport.sent.length = 0;
    h.session.stopAnswer();
    expect(h.transport.sent).toEqual([]);

    const idle = makeHarness();
    idle.session.stopAnswer();
    expect(idle.session.getState().activity).toBe("listening");
  });

  it("does not show an error for the cancel the server could not use", async () => {
    const h = await started("voice");
    // thinking, but the server has no response yet: it will reject the cancel
    h.transport.push(ev.speechStarted("u1"));
    h.transport.push(ev.speechStopped("u1"));
    expect(h.session.getState().activity).toBe("thinking");
    h.session.stopAnswer();
    await settle(100);
    expect(h.session.getState().notice).toBeNull();
    expect(h.session.getState().connection.status).toBe("connected");
  });
});

describe("mute", () => {
  it("flips track.enabled without renegotiating or sending anything", async () => {
    const h = await started("voice");
    const track = h.micStreams[0]?.tracks[0];
    h.transport.sent.length = 0;

    h.session.setMuted(true);
    expect(track?.enabled).toBe(false);
    expect(h.session.getState().muted).toBe(true);
    h.session.setMuted(false);
    expect(track?.enabled).toBe(true);
    expect(h.session.getState().muted).toBe(false);
    expect(h.transport.sent).toEqual([]);
    expect(h.createTransport).toHaveBeenCalledOnce();
    expect(track?.stop).not.toHaveBeenCalled();
  });

  it("does nothing in text mode, where there is no mic", async () => {
    const h = await started("text");
    h.session.setMuted(true);
    expect(h.session.getState().muted).toBe(false);
  });
});

describe("typed messages", () => {
  const ANSWER = "Revenue grew twelve percent last year.";

  it("sends the item and then asks for a text-only reply in text mode", async () => {
    const h = await started("text", { script: scenarioScript("text-turn") });
    h.session.sendText("  What was revenue?  ");
    expect(sentTypes(h)).toEqual([
      "conversation.item.create",
      "response.create",
    ]);
    const [create, respond] = h.transport.sent;
    expect(create).toMatchObject({
      item: {
        role: "user",
        content: [{ type: "input_text", text: "What was revenue?" }],
      },
    });
    expect(respond).toMatchObject({
      response: { output_modalities: ["text"] },
    });
    // The bubble is there before the server says anything.
    expect(transcript(h.session.getState())).toEqual([
      ["user", "sending", "What was revenue?"],
    ]);

    await settle(1500);
    expect(transcript(h.session.getState())).toEqual([
      ["user", "done", "What was revenue?"],
      ["assistant", "done", ANSWER],
    ]);
    expect(h.session.getState().activity).toBe("listening");
    expect(h.session.getState().usage.responses).toBe(1);
  });

  it("asks for the default (spoken) reply when typed during a voice chat", async () => {
    const h = await started("voice", {
      script: { steps: [], replyWith: "audio" },
    });
    h.session.sendText("Hello");
    expect(h.transport.sent[1]).toEqual(
      expect.objectContaining({ type: "response.create" }),
    );
    expect(
      (h.transport.sent[1] as { response?: unknown }).response,
    ).toBeUndefined();
  });

  it("ignores blank text and anything while not connected", async () => {
    const h = await started("text");
    h.session.sendText("   ");
    expect(h.transport.sent).toEqual([]);
    const idle = makeHarness();
    idle.session.sendText("hi");
    expect(idle.session.getState().order).toEqual([]);
  });

  it("replaces an answer in progress: cancel first, then the new question", async () => {
    const h = await started("text", {
      script: {
        steps: [],
        replyWith: "text",
        textAnswer: "one two three four five six seven eight",
      },
    });
    h.session.sendText("First");
    await settle(200);
    h.transport.sent.length = 0;

    h.session.sendText("Second");
    expect(sentTypes(h)).toEqual([
      "response.cancel",
      "conversation.item.create",
      "response.create",
    ]);
    await settle(3000);
    const rows = transcript(h.session.getState());
    expect(rows[0]).toEqual(["user", "done", "First"]);
    expect(rows[1]?.[1]).toBe("interrupted");
    expect(rows.at(-2)).toEqual(["user", "done", "Second"]);
    expect(rows.at(-1)?.[1]).toBe("done");
  });

  it("marks the bubble 'not sent' when the channel cannot take it, and retries it", async () => {
    const h2 = await started("text", { script: scenarioScript("text-turn") });
    const send = vi.spyOn(h2.transport, "send").mockReturnValueOnce(false);
    h2.session.sendText("Will fail");
    expect(transcript(h2.session.getState())).toEqual([
      ["user", "sendFailed", "Will fail"],
    ]);
    expect(h2.session.getState().activity).toBe("listening");
    send.mockRestore();

    const failedId = h2.session.getState().order[0] ?? "";
    h2.session.retryText(failedId);
    await settle(1500);
    expect(transcript(h2.session.getState()).map((r) => r[2])).toEqual([
      "Will fail",
      ANSWER,
    ]);
    // Only a failed bubble can be retried.
    const doneId = h2.session.getState().order[0] ?? "";
    h2.transport.sent.length = 0;
    h2.session.retryText(doneId);
    h2.session.retryText("nope");
    expect(h2.transport.sent).toEqual([]);
  });

  it("marks the bubble 'not sent' when the server rejects it", async () => {
    const h = await started("text");
    h.session.sendText("Bad one");
    const create = h.transport.sent[0];
    h.transport.push(ev.error("invalid_value", create?.event_id));
    expect(transcript(h.session.getState())).toEqual([
      ["user", "sendFailed", "Bad one"],
    ]);
    expect(h.session.getState().connection.status).toBe("connected");
  });
});

describe("limits and timers", () => {
  it("warns a minute before the cap, then ends the chat with the max-duration reason", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 180 } });
    // Keep it from idling out.
    const ping = () => h.transport.push(ev.speechStarted("u"));
    await settle(CAP_WARNING_MS * 2 - 1000);
    expect(h.session.getState().notice).toBeNull();
    ping();
    await settle(1000);
    expect(h.session.getState().notice).toEqual({
      kind: "cap_warning",
      secondsLeft: 60,
    });
    expect(status(h)).toBe("connected");

    ping();
    await settle(CAP_WARNING_MS);
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "max_duration",
    });
    h.expectAllReleased();
  });

  it("skips the warning when the whole chat is a minute or less", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 45 } });
    await settle(44_000);
    expect(h.session.getState().notice).toBeNull();
    await settle(2_000);
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "max_duration",
    });
  });

  it("ends a silent chat after 2 minutes", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 1800 } });
    await settle(IDLE_MS - 1000);
    expect(status(h)).toBe("connected");
    await settle(2000);
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "idle",
    });
    h.expectAllReleased();
  });

  it("restarts the idle clock on speech", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 1800 } });
    await settle(IDLE_MS - 10_000);
    h.transport.push(ev.speechStarted("u1"));
    h.transport.push(ev.speechStopped("u1"));
    await settle(IDLE_MS - 10_000);
    expect(status(h)).toBe("connected");
    await settle(20_000);
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "idle",
    });
  });

  it("never idles out in the middle of an answer", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 1800 } });
    h.transport.push(ev.responseCreated("r1"));
    h.transport.push(ev.audioStarted("r1"));
    await settle(IDLE_MS * 2);
    expect(status(h)).toBe("connected");
    h.transport.push(ev.audioStopped("r1"));
    h.transport.push(ev.responseDone("r1"));
    await settle(IDLE_MS + 1000);
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "idle",
    });
  });

  it("ends a chat that stays in the background for a minute", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 1800 } });
    h.setHidden(true);
    await settle(HIDDEN_MS - 1000);
    expect(status(h)).toBe("connected");
    await settle(2000);
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "hidden",
    });
    h.expectAllReleased();
  });

  it("keeps the chat if the user comes back in time", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 1800 } });
    h.setHidden(true);
    await settle(HIDDEN_MS - 5000);
    h.setHidden(false);
    await settle(HIDDEN_MS);
    expect(status(h)).toBe("connected");
  });

  describe("when the browser froze the timers in a background tab", () => {
    // vi.setSystemTime moves the clock without running any timer, which is
    // what a suspended tab looks like from the page when it comes back.
    const jump = (ms: number) => vi.setSystemTime(Date.now() + ms);

    it("ends the chat on return if it was hidden for longer than a minute", async () => {
      const h = await started("voice", {
        session: { maxSessionSeconds: 1800 },
      });
      h.setHidden(true);
      jump(10 * 60_000);
      expect(status(h)).toBe("connected"); // the timer never fired
      h.setHidden(false);
      expect(h.session.getState().connection).toEqual({
        status: "ended",
        reason: "hidden",
      });
      h.expectAllReleased();
    });

    it("keeps the chat if the tab was hidden for less than a minute", async () => {
      const h = await started("voice", {
        session: { maxSessionSeconds: 1800 },
      });
      h.setHidden(true);
      jump(HIDDEN_MS - 5000);
      h.setHidden(false);
      expect(status(h)).toBe("connected");
      // The hidden timer was cancelled: it must not fire a minute later.
      await settle(HIDDEN_MS + 1000);
      expect(status(h)).toBe("connected");
    });

    it("does not count an earlier, shorter hide towards a later one", async () => {
      const h = await started("voice", {
        session: { maxSessionSeconds: 1800 },
      });
      h.setHidden(true);
      jump(20_000);
      h.setHidden(false);
      // 90 s of visible time is more than the hidden limit but under the
      // idle limit: visible time must not count as hidden time.
      jump(90_000);
      h.setHidden(false);
      expect(status(h)).toBe("connected");
    });

    it("ends the chat at the cap even though its timer was frozen", async () => {
      const h = await started("voice", { session: { maxSessionSeconds: 180 } });
      jump(200_000);
      expect(status(h)).toBe("connected");
      h.setHidden(false); // e.g. the page came back to the foreground
      expect(h.session.getState().connection).toEqual({
        status: "ended",
        reason: "max_duration",
      });
    });

    it("ends a silent chat whose idle timer was frozen", async () => {
      const h = await started("voice", {
        session: { maxSessionSeconds: 1800 },
      });
      jump(IDLE_MS + 5000);
      h.setHidden(false);
      expect(h.session.getState().connection).toEqual({
        status: "ended",
        reason: "idle",
      });
    });

    it("does not end a chat that is in the middle of an answer", async () => {
      const h = await started("voice", {
        session: { maxSessionSeconds: 1800 },
      });
      h.transport.push(ev.responseCreated("r1"));
      h.transport.push(ev.audioStarted("r1"));
      jump(IDLE_MS + 5000);
      h.setHidden(false);
      expect(status(h)).toBe("connected");
    });

    it("measures a hide that began before the chat connected", async () => {
      const h = makeHarness({ session: { maxSessionSeconds: 1800 } });
      h.setHidden(true);
      h.session.start("voice");
      await settle(50);
      jump(HIDDEN_MS + 1000);
      h.setHidden(false);
      expect(h.session.getState().connection).toEqual({
        status: "ended",
        reason: "hidden",
      });
    });
  });

  it("counts a tab that was already hidden when the chat connected", async () => {
    const h = makeHarness({ session: { maxSessionSeconds: 1800 } });
    h.setHidden(true);
    h.session.start("voice");
    await settle(HIDDEN_MS + 1000);
    expect(h.session.getState().connection).toEqual({
      status: "ended",
      reason: "hidden",
    });
  });
});

describe("a flaky link", () => {
  it("shows reconnecting, and recovers if the link comes back inside the grace period", async () => {
    const h = await started("voice");
    h.transport.emitState("disconnected");
    expect(status(h)).toBe("reconnecting");
    await settle(RECONNECT_GRACE_MS - 1000);
    h.transport.emitState("connected");
    expect(status(h)).toBe("connected");
    await settle(RECONNECT_GRACE_MS * 2);
    expect(status(h)).toBe("connected");
  });

  it("keeps the transcript on screen after the link fails", async () => {
    const h = await started("voice", { script: scenarioScript("normal-turn") });
    await settle(3000);
    // Nothing more can be minted today, so the reconnect ends the chat.
    h.mint.mockRejectedValue(new MintError("daily_limit"));
    h.transport.emitState("failed");
    await settle();
    expect(status(h)).toBe("failed");
    expect(h.session.getState().order).toHaveLength(2);
  });
});

describe("what comes in from the server", () => {
  it("treats a billing error as fatal and tears everything down", async () => {
    const h = await started("voice", { script: scenarioScript("budget") });
    await settle(1500);
    expect(h.session.getState().connection).toEqual({
      status: "failed",
      code: "budget_exhausted",
    });
    h.expectAllReleased();
  });

  it("survives a recoverable error and keeps going", async () => {
    const h = await started("voice", { script: scenarioScript("error") });
    await settle(6000);
    const s = h.session.getState();
    expect(s.notice).toEqual({ kind: "error", code: "invalid_value" });
    expect(s.connection.status).toBe("connected");
    expect(transcript(s)).toHaveLength(2);
  });

  it("counts unknown and malformed events, logging them only when debugging", async () => {
    const quiet = await started("voice", {
      script: scenarioScript("unknown-event"),
    });
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    await settle(3000);
    expect(quiet.session.getState().diagnostics.unknown).toBe(1);
    expect(spy).not.toHaveBeenCalled();

    const loud = await started("voice", {
      script: scenarioScript("unknown-event"),
      debug: true,
    });
    await settle(3000);
    expect(loud.session.getState().diagnostics).toMatchObject({
      unknown: 1,
      malformed: 2,
    });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("ignores events it knows and does not need", async () => {
    const h = await started("voice");
    h.transport.push({ type: "rate_limits.updated", rate_limits: [] });
    h.transport.push({ type: "conversation.created" });
    expect(h.session.getState().diagnostics.unknown).toBe(0);
  });
});

describe("level meters", () => {
  it("feeds subscribers, keeps them across restarts and zeroes the bars at the end", async () => {
    const h = makeHarness();
    const got: number[] = [];
    const off = h.session.subscribeLevel("mic", (l) => got.push(l));
    expect(h.meters).toHaveLength(0); // nothing to meter before a chat

    h.session.start("voice");
    await settle(50);
    expect(h.meters[0]?.running).toBe(true);
    h.contexts[0]!.analysers[0]!.samples = [64, 192];
    h.frames.step();
    expect(got.at(-1)).toBe(1);

    h.session.end();
    expect(got.at(-1)).toBe(0);
    expect(h.meters[0]?.running).toBe(false);

    h.session.start("voice");
    await settle(50);
    expect(h.meters[1]?.running).toBe(true);
    off();
    expect(h.meters[1]?.running).toBe(false);
  });

  it("only polls the audio while somebody is listening", async () => {
    const h = await started("voice");
    expect(h.meters[0]?.running).toBe(false);
    const off = h.session.subscribeLevel("remote", () => {});
    expect(h.meters[0]?.running).toBe(false); // no remote stream attached yet
    off();
  });

  it("attaches the model's voice when the transport reports it", async () => {
    const h = await started("voice");
    const got: number[] = [];
    h.session.subscribeLevel("remote", (l) => got.push(l));
    // Mock transports have no remote audio; attach one through the meter directly.
    h.meters[0]?.attach("remote", h.micStreams[0] as never);
    h.contexts[0]!.analysers.at(-1)!.samples = [64, 192];
    h.frames.step();
    expect(got.at(-1)).toBe(1);
  });
});

describe("the dev event recorder", () => {
  it("records what came in, what went out and the key moments, fresh per chat", async () => {
    const h = makeHarness({
      recorder: true,
      script: scenarioScript("text-turn"),
    });
    h.session.start("text");
    await settle(50);
    h.session.sendText("Hi");
    await settle(1500);

    const lines = h.recorders[0]!.toJsonl()
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      dir: "meta",
      data: { event: "start", mode: "text" },
    });
    expect(
      lines.some((l) => l.dir === "meta" && l.data.event === "minted"),
    ).toBe(true);
    expect(
      lines.filter((l) => l.dir === "out").map((l) => l.data.type),
    ).toEqual(["conversation.item.create", "response.create"]);
    expect(
      lines.some((l) => l.dir === "in" && l.data.type === "session.created"),
    ).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(h.response.clientSecret);

    h.session.end();
    expect(h.session.recorder).toBe(h.recorders[0]); // still there to download
    h.session.start("text");
    expect(h.recorders).toHaveLength(2);
  });

  it("records nothing and creates nothing when dev tools are off", async () => {
    const h = await started("text");
    expect(h.session.recorder).toBeNull();
  });

  it("notes why the mic failed", async () => {
    const h = makeHarness({ recorder: true, mic: "denied" });
    h.session.start("voice");
    await settle(50);
    expect(h.recorders[0]?.toJsonl()).toContain('"reason":"denied"');
  });
});

describe("subscriptions", () => {
  it("notifies once per change and stops after unsubscribe", async () => {
    const h = makeHarness();
    const listener = vi.fn();
    const off = h.session.subscribe(listener);
    h.session.start("text");
    await settle(50);
    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.length;
    off();
    h.session.end();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("returns the same state object while nothing changes", async () => {
    const h = await started("text");
    const a = h.session.getState();
    h.session.setMuted(false);
    h.session.stopAnswer();
    expect(h.session.getState()).toBe(a);
  });
});
