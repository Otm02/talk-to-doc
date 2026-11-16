import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeHarness,
  type Harness,
  type HarnessOptions,
} from "@test/realtime/harness";
import { MintError } from "./mint";
import { scenarioScript } from "./mock-scenarios";
import type { MockScript } from "./mock-transport";
import { RECONNECT_GRACE_MS } from "./reconnect";
import {
  FIRST_START_OFFLINE_WAIT_MS,
  IDLE_MS,
  MIC_REACQUIRE_MIN_MS,
} from "./session";
import { TransportError } from "./transport";
import { ev } from "./wire-events";

// The controller around the reconnect machine, on MockTransport and fake
// timers: what a user sees and what the network is asked for.

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

/** A chat with two turns on screen, so there is a conversation to carry over. */
const talking = (options: HarnessOptions = {}) =>
  started("voice", { script: scenarioScript("normal-turn"), ...options });

const conn = (h: Harness) => h.session.getState().connection;
const status = (h: Harness) => conn(h).status;
const phase = (h: Harness) => {
  const c = conn(h);
  return c.status === "reconnecting" ? c.phase : null;
};
const code = (h: Harness) => {
  const c = conn(h);
  return c.status === "failed" ? c.code : null;
};

describe("a link that heals by itself", () => {
  it("shows Reconnecting, then carries on with no new secret", async () => {
    const h = await started();
    h.transport.emitState("disconnected");
    expect(status(h)).toBe("reconnecting");
    expect(phase(h)).toBe("grace");

    await settle(RECONNECT_GRACE_MS - 1000);
    h.transport.emitState("connected");
    expect(status(h)).toBe("connected");

    await settle(RECONNECT_GRACE_MS * 2);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.transports).toHaveLength(1);
    expect(h.session.getState().reconnectMarks).toEqual([]);
  });
});

describe("a full reconnect", () => {
  it("mints exactly one new secret, reuses the mic stream and keeps the transcript", async () => {
    const h = await talking();
    await settle(3000);
    const before = h.session.getState();
    expect(before.order).toHaveLength(2);

    h.transport.emitState("failed");
    expect(status(h)).toBe("reconnecting");
    await settle(100);

    expect(status(h)).toBe("connected");
    // The chat's own secret plus ONE for the reconnect.
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    // The mic was never asked for again, and the same stream is on the new line.
    expect(h.requestMic).toHaveBeenCalledOnce();
    expect(h.transports[1]?.lastConnect?.micStream).toBe(h.micStreams[0]);
    expect(h.transports[1]?.lastConnect?.clientSecret).toBe(
      h.response.clientSecret,
    );
    // The old line was released exactly once.
    expect(h.transports[0]?.closeCount).toBe(1);
    // The turns so far went up as history, oldest first.
    const history = h.mint.mock.calls[1]?.[2];
    expect(history).toHaveLength(2);
    expect(history?.map((t) => t.role)).toEqual(["user", "assistant"]);
    // The transcript is still there, and the new session is marked.
    expect(h.session.getState().order).toEqual(before.order);
    expect(h.session.getState().reconnectMarks).toEqual([
      h.session.getState().epoch,
    ]);
    expect(h.session.getState().epoch).toBe(before.epoch + 1);
  });

  it("goes through grace first when the link only says disconnected", async () => {
    const h = await started();
    h.transport.emitState("disconnected");
    await settle(RECONNECT_GRACE_MS - 1);
    expect(h.mint).toHaveBeenCalledOnce();
    await settle(100);
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(status(h)).toBe("connected");
  });

  it("treats the server's session-expired error like a dead link", async () => {
    const h = await started();
    h.transport.push(ev.error("session_expired"));
    await settle(100);
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(status(h)).toBe("connected");
  });

  it("does not reconnect for any other error event", async () => {
    const h = await started();
    h.transport.push(ev.error("invalid_value"));
    await settle(100);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(status(h)).toBe("connected");
  });

  it("does not count the reconnect against the chat's length", async () => {
    const h = await started("voice", { session: { maxSessionSeconds: 100 } });
    await settle(40_000);
    h.transport.emitState("failed");
    await settle(100);
    expect(status(h)).toBe("connected");
    await settle(58_000);
    expect(status(h)).toBe("connected");
    await settle(3_000);
    expect(conn(h)).toEqual({ status: "ended", reason: "max_duration" });
    h.expectAllReleased();
  });

  it("does not end a reconnecting chat as idle", async () => {
    const h = await started();
    h.setOffline(true);
    h.transport.emitState("failed");
    await settle(IDLE_MS + 30_000);
    expect(status(h)).toBe("reconnecting");
    expect(phase(h)).toBe("waitingNetwork");
  });

  it("ignores a link event from a transport it has already replaced", async () => {
    const h = await started();
    const old = h.transport;
    old.emitState("failed");
    await settle(100);
    expect(status(h)).toBe("connected");
    old.emitState("failed");
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  it("gives the screen a phase for every step", async () => {
    const h = await started();
    h.mint.mockImplementationOnce(
      () => new Promise(() => {}), // never answers
    );
    h.transport.emitState("failed");
    expect(phase(h)).toBe("minting");
    expect(conn(h)).toMatchObject({ attempt: 1, maxAttempts: 3 });
  });
});

describe("a connection that keeps failing", () => {
  it("tries three times with backoff, then says Connection lost and mints no more", async () => {
    const h = await started();
    for (let i = 0; i < 3; i++) {
      h.queueTransport({ connectDelayMs: 0, steps: [], failWith: "network" });
    }
    h.transport.emitState("failed");

    await settle(1); // attempt 1, no wait
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(phase(h)).toBe("backoff");

    await settle(1_900);
    expect(h.mint).toHaveBeenCalledTimes(2);
    await settle(200); // attempt 2 after 2 s
    expect(h.mint).toHaveBeenCalledTimes(3);
    expect(phase(h)).toBe("backoff");

    await settle(3_700);
    expect(h.mint).toHaveBeenCalledTimes(3);
    await settle(500); // attempt 3 after 4 s
    expect(h.mint).toHaveBeenCalledTimes(4);

    await settle(100);
    expect(conn(h)).toEqual({
      status: "failed",
      code: "session_reconnect_failed",
      fromReconnect: true,
    });
    await settle(60_000);
    expect(h.mint).toHaveBeenCalledTimes(4);
    h.expectAllReleased();
  });

  it("recovers on the second attempt and counts one new mint per attempt", async () => {
    const h = await started();
    h.queueTransport({ connectDelayMs: 0, steps: [], failWith: "timeout" });
    h.transport.emitState("failed");
    await settle(2_100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(3);
  });

  it("stops at once on a billing error from the connect", async () => {
    const h = await started();
    h.queueTransport({ connectDelayMs: 0, steps: [], failWith: "budget" });
    h.transport.emitState("failed");
    await settle(100);
    expect(code(h)).toBe("budget_exhausted");
    await settle(20_000);
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  it("keeps the transcript for the Connection lost card", async () => {
    const h = await talking();
    await settle(3000);
    h.mint.mockRejectedValue(new MintError("session_connect_failed"));
    h.transport.emitState("failed");
    await settle(10_000);
    expect(code(h)).toBe("session_reconnect_failed");
    expect(h.session.getState().order).toHaveLength(2);
    h.expectAllReleased();
  });
});

describe("a 429 in the middle of a reconnect", () => {
  it("shows the cooldown with its deadline, then resumes at 0 with one mint", async () => {
    const h = await started();
    h.mint.mockRejectedValueOnce(new MintError("rate_limited", 30));
    const t0 = Date.now();
    h.transport.emitState("failed");
    await settle(10);

    expect(phase(h)).toBe("cooldown");
    const c = conn(h);
    expect(c.status === "reconnecting" && c.retryAt).toBe(t0 + 30_000);
    expect(h.mint).toHaveBeenCalledTimes(2);

    await settle(29_000);
    expect(phase(h)).toBe("cooldown");
    expect(h.mint).toHaveBeenCalledTimes(2);

    await settle(1_100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(3);
    expect(h.session.getState().reconnectMarks).toHaveLength(1);
  });

  it("never turns into a retry loop: the third 429 shows the cooldown card", async () => {
    const h = await started();
    h.mint.mockRejectedValue(new MintError("rate_limited", 5));
    h.transport.emitState("failed");
    await settle(5_100);
    await settle(5_100);
    await settle(100);
    expect(h.mint).toHaveBeenCalledTimes(4);
    expect(conn(h)).toMatchObject({
      status: "failed",
      code: "rate_limited",
      retryAfterSeconds: 5,
    });
    await settle(120_000);
    expect(h.mint).toHaveBeenCalledTimes(4);
  });

  it("stays a cooldown, not Offline, while the device is online", async () => {
    const h = await started();
    h.mint.mockRejectedValueOnce(new MintError("rate_limited", 30));
    h.transport.emitState("failed");
    await settle(10);
    expect(phase(h)).toBe("cooldown");
    expect(h.waitingForNetwork).toBe(0);
  });
});

describe("errors that never reconnect", () => {
  it.each(["voice_disabled", "daily_limit", "budget_exhausted"] as const)(
    "%s ends the chat and mints nothing more",
    async (errorCode) => {
      const h = await started();
      h.mint.mockRejectedValue(new MintError(errorCode));
      h.transport.emitState("failed");
      await settle(100);
      expect(code(h)).toBe(errorCode);
      await settle(60_000);
      expect(h.mint).toHaveBeenCalledTimes(2);
      h.expectAllReleased();
    },
  );

  it("keeps the wait a daily limit came with", async () => {
    const h = await started();
    h.mint.mockRejectedValue(new MintError("daily_limit", 7200));
    h.transport.emitState("failed");
    await settle(100);
    expect(conn(h)).toMatchObject({
      status: "failed",
      code: "daily_limit",
      retryAfterSeconds: 7200,
    });
  });

  it("an expired document ends the chat with doc_not_found", async () => {
    const h = await started();
    h.mint.mockRejectedValue(new MintError("doc_not_found"));
    h.transport.emitState("failed");
    await settle(100);
    expect(code(h)).toBe("doc_not_found");
    expect(h.mint).toHaveBeenCalledTimes(2);
  });
});

describe("offline", () => {
  it("waits for the network without minting, then reconnects", async () => {
    const h = await started();
    h.setOffline(true);
    h.transport.emitState("failed");
    await settle(100);
    expect(phase(h)).toBe("waitingNetwork");

    await settle(120_000);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.waitingForNetwork).toBe(1);

    h.setOffline(false);
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  it("End while waiting for the network releases everything", async () => {
    const h = await started();
    h.setOffline(true);
    h.transport.emitState("failed");
    await settle(100);
    h.session.end();
    expect(conn(h)).toEqual({ status: "ended", reason: "user" });
    expect(h.waitingForNetwork).toBe(0);
    h.setOffline(false);
    await settle(100);
    expect(h.mint).toHaveBeenCalledOnce();
    h.expectAllReleased();
  });

  it("End during the mint aborts it", async () => {
    const h = await started();
    let aborted = false;
    h.mint.mockImplementationOnce(
      (_id, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    h.transport.emitState("failed");
    await settle(10);
    expect(phase(h)).toBe("minting");
    h.session.end();
    await settle(10);
    expect(aborted).toBe(true);
    expect(conn(h)).toEqual({ status: "ended", reason: "user" });
    h.expectAllReleased();
  });

  it("End during the connect closes the half-open transport", async () => {
    const h = await started();
    h.queueTransport({ connectDelayMs: 5_000, steps: [] });
    h.transport.emitState("failed");
    await settle(100);
    expect(phase(h)).toBe("connecting");
    h.session.end();
    await settle(10);
    expect(h.transports.every((t) => t.closeCount === 1)).toBe(true);
    h.expectAllReleased();
  });
});

describe("the first start while offline", () => {
  it("keeps the mic prompt's result, waits, and mints once the connection is back", async () => {
    const h = makeHarness();
    h.setOffline(true);
    h.mint.mockRejectedValueOnce(new MintError("session_network_failed"));
    h.session.start("voice");
    await settle(50);

    const c = conn(h);
    expect(c).toEqual({ status: "connecting", phase: "waitingNetwork" });
    expect(h.requestMic).toHaveBeenCalledOnce();
    expect(h.mint).toHaveBeenCalledOnce();

    h.setOffline(false);
    await settle(100);
    expect(status(h)).toBe("connected");
    // One refused attempt that created nothing, then the chat's one secret.
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.requestMic).toHaveBeenCalledOnce();
    expect(h.transports).toHaveLength(1);
  });

  it("gives up after a minute and releases the mic", async () => {
    const h = makeHarness();
    h.setOffline(true);
    h.mint.mockRejectedValueOnce(new MintError("session_network_failed"));
    h.session.start("voice");
    await settle(FIRST_START_OFFLINE_WAIT_MS + 1_000);
    expect(code(h)).toBe("session_network_failed");
    expect(h.mint).toHaveBeenCalledOnce();
    h.expectAllReleased();
  });

  it("fails if the second try gets no answer either", async () => {
    const h = makeHarness();
    h.setOffline(true);
    h.mint.mockRejectedValue(new MintError("session_network_failed"));
    h.session.start("voice");
    await settle(50);
    h.setOffline(false);
    await settle(100);
    expect(code(h)).toBe("session_network_failed");
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  it("is not a reason to wait when the server answered with a refusal", async () => {
    const h = makeHarness();
    h.mint.mockRejectedValueOnce(new MintError("rate_limited", 20));
    h.session.start("voice");
    await settle(50);
    expect(conn(h)).toMatchObject({ status: "failed", code: "rate_limited" });
    expect(h.mint).toHaveBeenCalledOnce();
  });
});

describe("Connection lost: Reconnect and Switch to text", () => {
  async function lost(): Promise<Harness> {
    const h = await talking();
    await settle(3000);
    h.mint.mockRejectedValueOnce(new MintError("session_connect_failed"));
    h.mint.mockRejectedValueOnce(new MintError("session_connect_failed"));
    h.mint.mockRejectedValueOnce(new MintError("session_connect_failed"));
    h.transport.emitState("failed");
    await settle(10_000);
    expect(code(h)).toBe("session_reconnect_failed");
    return h;
  }

  it("Reconnect starts one new chat session with the transcript carried over", async () => {
    const h = await lost();
    const minted = h.mint.mock.calls.length;
    h.session.reconnect();
    await settle(100);

    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(minted + 1);
    expect(h.mint.mock.lastCall?.[2]).toHaveLength(2);
    expect(h.session.getState().order).toHaveLength(2);
    expect(h.session.getState().mode).toBe("voice");
    expect(h.session.getState().reconnectMarks).toHaveLength(1);
  });

  it("Switch to text starts a text chat with the same transcript and no mic", async () => {
    const h = await lost();
    h.session.switchToText();
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.session.getState().mode).toBe("text");
    expect(h.transport.lastConnect?.micStream).toBeNull();
    expect(h.session.getState().order).toHaveLength(2);
    expect(h.mint.mock.lastCall?.[2]).toHaveLength(2);
  });

  it("does nothing unless the chat is in the Connection lost state", async () => {
    const h = await started();
    h.session.reconnect();
    h.session.switchToText();
    await settle(100);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.transports).toHaveLength(1);
  });
});

describe("the mic track ends mid-chat", () => {
  it("gets the mic once more and swaps it in: no new secret, still voice", async () => {
    const h = await started();
    const dead = h.micStreams[0];
    dead?.tracks[0]?.end();
    await settle(100);

    const fresh = h.micStreams[1];
    expect(h.requestMic).toHaveBeenCalledTimes(2);
    expect(h.transport.micUpgrades).toEqual([fresh]);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.transports).toHaveLength(1);
    expect(h.session.getState()).toMatchObject({
      mode: "voice",
      micIssue: null,
    });
    expect(dead?.tracks[0]?.stop).toHaveBeenCalled();
    expect(status(h)).toBe("connected");
  });

  it("keeps a muted chat muted across the swap", async () => {
    const h = await started();
    h.session.setMuted(true);
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    expect(h.session.getState().muted).toBe(true);
    expect(h.micStreams[1]?.tracks[0]?.enabled).toBe(false);
  });

  it("falls back to text if it dies again right away", async () => {
    const h = await started();
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    h.micStreams[1]?.tracks[0]?.end();
    await settle(100);
    expect(h.requestMic).toHaveBeenCalledTimes(2);
    expect(h.session.getState().mode).toBe("text");
    expect(h.mint).toHaveBeenCalledOnce();
  });

  it("tries again once enough time has passed", async () => {
    const h = await started();
    h.micStreams[0]?.tracks[0]?.end();
    await settle(MIC_REACQUIRE_MIN_MS + 100);
    h.micStreams[1]?.tracks[0]?.end();
    await settle(100);
    expect(h.requestMic).toHaveBeenCalledTimes(3);
    expect(h.session.getState().mode).toBe("voice");
  });

  it("falls back to text when the connection will not take the new track, and stops the new stream", async () => {
    const h = await started("voice", {
      script: { steps: [], micUpgrade: "fail" },
    });
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    expect(h.session.getState().mode).toBe("text");
    expect(h.micStreams[1]?.tracks[0]?.stop).toHaveBeenCalled();
    expect(h.mint).toHaveBeenCalledOnce();
  });

  it("falls back to text when the browser refuses the mic", async () => {
    const h = await started();
    h.setMic("denied");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    expect(h.session.getState()).toMatchObject({
      mode: "text",
      micIssue: "denied",
    });
  });

  it("during a reconnect, the next connect uses the new stream", async () => {
    const h = await started();
    h.setOffline(true);
    h.transport.emitState("failed");
    await settle(100);
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    expect(h.micStreams[1]).toBeDefined();
    expect(h.mint).toHaveBeenCalledOnce();

    h.setOffline(false);
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.transports[1]?.lastConnect?.micStream).toBe(h.micStreams[1]);
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  it("is not triggered by a mic that ends after the chat did", async () => {
    const h = await started();
    const track = h.micStreams[0]?.tracks[0];
    h.session.end();
    track?.end();
    await settle(100);
    expect(h.requestMic).toHaveBeenCalledOnce();
  });
});

describe("odd corners of a reconnect", () => {
  it("an error event with no code is not a dead link", async () => {
    const h = await started();
    h.transport.push({
      type: "error",
      error: { type: "server_error", message: "x" },
    });
    await settle(100);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(status(h)).toBe("connected");
  });

  it("an unexpected throw from the mint counts as a failed attempt, not a hang", async () => {
    const h = await started();
    h.mint.mockRejectedValueOnce(new Error("boom"));
    h.transport.emitState("failed");
    await settle(2_100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(3);
  });

  it("a transport that cannot even be built counts as a failed attempt", async () => {
    const h = await started();
    h.createTransport.mockRejectedValueOnce(new TransportError("unsupported"));
    h.transport.emitState("failed");
    await settle(2_100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(3);
  });

  it("closes a transport that was built after End", async () => {
    const h = await started();
    const { MockTransport } = await import("./mock-transport");
    const late = new MockTransport({ connectDelayMs: 0, steps: [] });
    let release: () => void = () => {};
    h.createTransport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(late);
        }),
    );
    h.transport.emitState("failed");
    await settle(10);
    h.session.end();
    release();
    await settle(10);
    expect(late.closeCount).toBe(1);
  });

  it("a text chat reconnects without a microphone", async () => {
    const h = await started("text");
    h.transport.emitState("failed");
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.transports[1]?.lastConnect?.micStream).toBeNull();
    expect(h.requestMic).not.toHaveBeenCalled();
  });

  it("ignores 'disconnected' while a new session is already being built", async () => {
    const h = await started();
    h.queueTransport({ connectDelayMs: 5_000, steps: [] });
    h.transport.emitState("failed");
    await settle(100);
    expect(phase(h)).toBe("connecting");
    h.transports[0]?.emitState("disconnected");
    h.transports[1]?.emitState("disconnected");
    expect(phase(h)).toBe("connecting");
  });

  it("End while the first start waits for the network leaves nothing behind", async () => {
    const h = makeHarness();
    h.setOffline(true);
    h.mint.mockRejectedValueOnce(new MintError("session_network_failed"));
    h.session.start("voice");
    await settle(50);
    expect(conn(h)).toMatchObject({ phase: "waitingNetwork" });
    h.session.end();
    await settle(100);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.waitingForNetwork).toBe(0);
    h.expectAllReleased();
  });

  it("a mic request that throws leaves a text chat, not a stuck one", async () => {
    const h = await started();
    h.requestMic.mockRejectedValueOnce(new Error("boom"));
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    expect(h.session.getState().mode).toBe("text");
    expect(status(h)).toBe("connected");
  });

  it("stops a mic that arrives after the chat has ended", async () => {
    const h = await started();
    h.setMic("pending");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(10);
    h.session.end();
    const late = h.resolveMic();
    await settle(10);
    expect(late.tracks[0]?.stop).toHaveBeenCalled();
  });
});

describe("a link that keeps dropping", () => {
  /** Every transport this chat builds fails `afterMs` after it connects. */
  const flaky = (afterMs: number): HarnessOptions => ({
    session: { maxSessionSeconds: 3_600 },
    script: { steps: [], linkSteps: [{ at: afterMs, state: "failed" }] },
  });

  it("is bounded: after three quick rebuilds the chat says Connection lost and mints no more", async () => {
    const h = await started("voice", flaky(1_000));
    await settle(10 * 60_000);
    expect(code(h)).toBe("session_reconnect_failed");
    // The chat's own secret, plus attempts 1, 2 and 3 of one long outage.
    expect(h.mint).toHaveBeenCalledTimes(4);
    h.expectAllReleased();
  });

  it("every one of those mints is for the same chat's history, not a fresh start", async () => {
    const h = await started("voice", {
      ...flaky(1_000),
      script: {
        ...scenarioScript("normal-turn"),
        linkSteps: [{ at: 3_000, state: "failed" }],
      },
    });
    await settle(10 * 60_000);
    expect(
      h.mint.mock.calls.slice(1).every((c) => (c[2]?.length ?? 0) > 0),
    ).toBe(true);
  });

  it("a link that holds for over 30 s each time still stops at six reconnect mints", async () => {
    const h = await started("voice", flaky(31_000));
    await settle(30 * 60_000);
    expect(code(h)).toBe("session_reconnect_failed");
    expect(h.mint).toHaveBeenCalledTimes(1 + 6);
    h.expectAllReleased();
  });

  it("a chat that is stable most of the time keeps recovering within the budget", async () => {
    const h = await started("voice", flaky(31_000));
    await settle(31_000 * 3 + 500);
    // Three drops so far, each rebuilt: still live.
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(1 + 3);
  });

  it("Reconnect after Connection lost starts a new chat with a new budget", async () => {
    const h = await started("voice", flaky(1_000));
    await settle(10 * 60_000);
    expect(code(h)).toBe("session_reconnect_failed");
    const before = h.mint.mock.calls.length;
    h.queueTransport({ connectDelayMs: 0, steps: [] });
    h.session.reconnect();
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(before + 1);
  });
});

describe("a mic replaced while the link is being rebuilt", () => {
  it("during grace: the healed link gets the new track swapped in (no new secret)", async () => {
    const h = await started();
    h.transport.emitState("disconnected");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    const fresh = h.micStreams[1];
    expect(fresh).toBeDefined();
    // Nothing to swap into while the link is down.
    expect(h.transport.micUpgrades).toEqual([]);

    h.transport.emitState("connected");
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.transport.micUpgrades).toEqual([fresh]);
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.session.getState().mode).toBe("voice");
  });

  it("during grace, when the grace runs out instead: the new session is built with the new mic, with no extra swap", async () => {
    const h = await started();
    h.transport.emitState("disconnected");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    await settle(RECONNECT_GRACE_MS + 500);
    expect(status(h)).toBe("connected");
    expect(h.transports).toHaveLength(2);
    expect(h.transports[1]?.lastConnect?.micStream).toBe(h.micStreams[1]);
    expect(h.transports[0]?.micUpgrades).toEqual([]);
    expect(h.transports[1]?.micUpgrades).toEqual([]);
  });

  it("while the new connection is being made: swapped in once it is up", async () => {
    const h = await started();
    h.queueTransport({ connectDelayMs: 5_000, steps: [] });
    h.transport.emitState("failed");
    await settle(100);
    expect(phase(h)).toBe("connecting");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    await settle(5_500);
    expect(status(h)).toBe("connected");
    expect(h.transports[1]?.micUpgrades).toEqual([h.micStreams[1]]);
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  it("falls back to text if the healed link will not take the new track", async () => {
    const h = await started("voice", {
      script: { steps: [], micUpgrade: "fail" },
    });
    h.transport.emitState("disconnected");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    h.transport.emitState("connected");
    await settle(100);
    expect(h.session.getState()).toMatchObject({
      mode: "text",
      micIssue: "unavailable",
    });
    expect(h.micStreams[1]?.tracks[0]?.stop).toHaveBeenCalled();
    expect(status(h)).toBe("connected");
  });

  it("a muted chat stays muted through the swap", async () => {
    const h = await started();
    h.session.setMuted(true);
    h.transport.emitState("disconnected");
    h.micStreams[0]?.tracks[0]?.end();
    await settle(100);
    h.transport.emitState("connected");
    await settle(100);
    expect(h.session.getState().muted).toBe(true);
    expect(h.micStreams[1]?.tracks[0]?.enabled).toBe(false);
  });

  it("before the first connect: the connection is built with the new mic, not the dead one", async () => {
    const h = makeHarness({ script: { connectDelayMs: 100, steps: [] } });
    h.mint.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(h.response), 500);
        }),
    );
    h.session.start("voice");
    await settle(100);
    h.micStreams[0]?.tracks[0]?.end();
    await settle(900);
    expect(status(h)).toBe("connected");
    expect(h.transport.lastConnect?.micStream).toBe(h.micStreams[1]);
    expect(h.session.getState().mode).toBe("voice");
  });
});

describe("turning the mic on while the link dies", () => {
  it("does not restart the chat or mint a second secret: the rebuilt connection takes the mic", async () => {
    const h = await started("text");
    h.setMic("pending");
    h.session.enableMic();
    await settle(10);
    // The link dies while the permission prompt is open, and the device is offline.
    h.setOffline(true);
    h.transport.emitState("failed");
    await settle(100);
    expect(phase(h)).toBe("waitingNetwork");

    const stream = h.resolveMic();
    await settle(100);
    expect(h.session.getState().mode).toBe("voice");
    expect(status(h)).toBe("reconnecting");
    // Still the same reconnect, not a restarted chat.
    expect(h.mint).toHaveBeenCalledOnce();

    h.setOffline(false);
    await settle(100);
    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[1]?.lastConnect?.micStream).toBe(stream);
    h.session.end();
    h.expectAllReleased();
  });
});

describe("a mint that times out on the first start", () => {
  it("is a visible failure with one secret asked for, never a quiet second mint", async () => {
    const h = makeHarness();
    h.mint.mockRejectedValue(new MintError("session_connect_failed"));
    h.session.start("voice");
    await settle(60_000);
    expect(code(h)).toBe("session_connect_failed");
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.waitingForNetwork).toBe(0);
    h.expectAllReleased();
  });
});

describe("a failure that came out of a reconnect", () => {
  it("is marked, so Retry can keep the conversation", async () => {
    const h = await started();
    h.mint.mockRejectedValue(new MintError("daily_limit"));
    h.transport.emitState("failed");
    await settle(100);
    expect(conn(h)).toMatchObject({ status: "failed", fromReconnect: true });
  });

  it("is not marked when the first start fails", async () => {
    const h = makeHarness();
    h.mint.mockRejectedValue(new MintError("rate_limited", 10));
    h.session.start("voice");
    await settle(50);
    const c = conn(h);
    expect(c.status).toBe("failed");
    expect(c.status === "failed" && c.fromReconnect).toBeUndefined();
  });

  it("after a third 429 the countdown ends in a Retry that keeps the transcript and sends it as history", async () => {
    const h = await talking();
    await settle(3_000);
    const before = h.session.getState().order;
    expect(before).toHaveLength(2);

    h.mint.mockRejectedValue(new MintError("rate_limited", 5));
    h.transport.emitState("failed");
    await settle(20_000);
    expect(conn(h)).toMatchObject({
      status: "failed",
      code: "rate_limited",
      fromReconnect: true,
    });
    expect(h.session.getState().order).toEqual(before);

    // The countdown is over; the user taps Retry (actions.reconnect).
    h.mint.mockReset();
    h.mint.mockResolvedValue(h.response);
    h.queueTransport({ connectDelayMs: 0, steps: [] });
    h.session.reconnect();
    await settle(100);

    expect(status(h)).toBe("connected");
    expect(h.mint).toHaveBeenCalledOnce();
    expect(h.mint.mock.calls[0]?.[2]).toHaveLength(2);
    expect(h.session.getState().order).toEqual(before);
    expect(h.session.getState().reconnectMarks).toHaveLength(1);
  });
});

describe("adding a microphone to a text chat that has to start a new session", () => {
  /** A text chat (mic denied) whose connection will not take a mic track. */
  const textChat = (
    over: Omit<HarnessOptions, "script"> & {
      script?: Partial<MockScript>;
    } = {},
  ) =>
    started("voice", {
      mic: "denied",
      ...over,
      script: { steps: [], micUpgrade: "fail", ...over.script },
    });

  const addMic = async (h: Harness) => {
    h.setMic("ok", "prompt");
    h.session.enableMic();
    await settle(50);
  };

  it("keeps the chat's clock: the cap is not pushed back by the new session", async () => {
    const h = await textChat({ session: { maxSessionSeconds: 180 } });
    await settle(100_000);
    expect(status(h)).toBe("connected");

    await addMic(h);
    expect(h.transports).toHaveLength(2);
    expect(h.session.getState().mode).toBe("voice");
    expect(status(h)).toBe("connected");

    // 100 s in, so about 80 s are left, not a fresh 180.
    await settle(70_000);
    expect(status(h)).toBe("connected");
    // The one-minute warning is due now that under a minute is left.
    expect(h.session.getState().notice).toEqual({
      kind: "cap_warning",
      secondsLeft: 60,
    });
    await settle(15_000);
    expect(conn(h)).toEqual({ status: "ended", reason: "max_duration" });
    h.expectAllReleased();
  });

  it("says how little is left when the new session starts inside the last minute", async () => {
    // A 90 s cap, so this stays clear of the 2-minute idle hang-up.
    const h = await textChat({ session: { maxSessionSeconds: 90 } });
    await settle(50_000);
    await addMic(h);
    const left = h.session.getState().notice;
    expect(left?.kind).toBe("cap_warning");
    expect(
      left?.kind === "cap_warning" && left.secondsLeft,
    ).toBeLessThanOrEqual(40);
    await settle(41_000);
    expect(conn(h)).toEqual({ status: "ended", reason: "max_duration" });
  });

  it("keeps the reconnect allowance already spent: six mints for the chat, not six more", async () => {
    const h = await textChat({
      session: { maxSessionSeconds: 3_600 },
      script: { linkSteps: [{ at: 31_000, state: "failed" }] },
    });
    // Three quiet-link rebuilds are spent...
    await settle(31_000 * 3 + 5_000);
    expect(h.mint).toHaveBeenCalledTimes(1 + 3);
    expect(status(h)).toBe("connected");

    // ...then the mic is added, which starts one more session (not a reconnect).
    await addMic(h);
    expect(h.mint).toHaveBeenCalledTimes(1 + 3 + 1);

    await settle(30 * 60_000);
    expect(code(h)).toBe("session_reconnect_failed");
    // 6 reconnect mints per chat in all: 3 before, 3 after.
    expect(h.mint).toHaveBeenCalledTimes(1 + 6 + 1);
    h.expectAllReleased();
  });

  it("a brand new chat after it ends gets the full length again", async () => {
    const h = await textChat({ session: { maxSessionSeconds: 90 } });
    await settle(45_000);
    await addMic(h);
    await settle(50_000);
    expect(conn(h)).toEqual({ status: "ended", reason: "max_duration" });

    h.queueTransport({ steps: [] });
    h.session.start("text");
    await settle(100);
    await settle(80_000);
    expect(status(h)).toBe("connected");
    await settle(15_000);
    expect(conn(h)).toEqual({ status: "ended", reason: "max_duration" });
  });
});
