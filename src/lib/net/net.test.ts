// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOffline,
  markReachable,
  markUnreachable,
  resetConnectivityForTests,
  subscribeConnectivity,
  waitForConnection,
} from "./connectivity";
import { jitter, retryOnce } from "./retry";
import { sleep, withTimeout } from "./timeout";

function setOnLine(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

beforeEach(() => {
  vi.useFakeTimers();
  setOnLine(true);
  resetConnectivityForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("aborts on time and says it was the clock", () => {
    const d = withTimeout(undefined, 1000);
    vi.advanceTimersByTime(999);
    expect(d.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(true);
    d.dispose();
  });

  it("follows the caller's abort without calling it a timeout", () => {
    const parent = new AbortController();
    const d = withTimeout(parent.signal, 1000);
    parent.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(false);
    d.dispose();
  });

  it("is already aborted when the caller's signal is", () => {
    const parent = new AbortController();
    parent.abort();
    const d = withTimeout(parent.signal, 1000);
    expect(d.signal.aborted).toBe(true);
    d.dispose();
  });

  it("dispose stops the timer", () => {
    const d = withTimeout(undefined, 1000);
    d.dispose();
    vi.advanceTimersByTime(5000);
    expect(d.signal.aborted).toBe(false);
  });
});

describe("sleep", () => {
  it("rejects when aborted", async () => {
    const c = new AbortController();
    const p = sleep(1000, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("retryOnce", () => {
  it("retries a retryable failure exactly once, after jitter", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce("ok");
    const p = retryOnce(fn, { retryable: () => true, random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second time", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("x"));
    const p = retryOnce(fn, { retryable: () => true });
    const assertion = expect(p).rejects.toThrow("x");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws at once for a failure that must not repeat", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("no"));
    await expect(retryOnce(fn, { retryable: () => false })).rejects.toThrow(
      "no",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up when aborted during the wait", async () => {
    const c = new AbortController();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("x"));
    const p = retryOnce(fn, { retryable: () => true, signal: c.signal });
    const assertion = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10);
    c.abort();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("jitters within 25% of the base", () => {
    expect(jitter(1000, () => 0)).toBe(750);
    expect(jitter(1000, () => 1)).toBe(1250);
  });
});

describe("connectivity", () => {
  it("is offline when the browser says so, or after a request got no answer", () => {
    expect(isOffline()).toBe(false);
    setOnLine(false);
    expect(isOffline()).toBe(true);
    setOnLine(true);
    markUnreachable();
    expect(isOffline()).toBe(true);
    markReachable();
    expect(isOffline()).toBe(false);
  });

  it("tells subscribers once per change", () => {
    const l = vi.fn();
    const off = subscribeConnectivity(l);
    markUnreachable();
    markUnreachable();
    markReachable();
    expect(l).toHaveBeenCalledTimes(2);
    off();
    markUnreachable();
    expect(l).toHaveBeenCalledTimes(2);
  });

  it("the browser's online event clears a stale unreachable flag", () => {
    const l = vi.fn();
    subscribeConnectivity(l);
    markUnreachable();
    window.dispatchEvent(new Event("online"));
    expect(isOffline()).toBe(false);
  });

  it("waitForConnection resolves on the online event", async () => {
    setOnLine(false);
    const p = waitForConnection();
    setOnLine(true);
    window.dispatchEvent(new Event("online"));
    await expect(p).resolves.toBeUndefined();
  });

  it("probes with backoff while the browser claims to be online", async () => {
    markUnreachable();
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const p = waitForConnection(undefined, { probe });
    await vi.advanceTimersByTimeAsync(2000);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBeUndefined();
    expect(isOffline()).toBe(false);
  });

  it("never probes while the browser itself says offline", async () => {
    setOnLine(false);
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    void waitForConnection(undefined, { probe });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects when aborted", async () => {
    setOnLine(false);
    const c = new AbortController();
    const p = waitForConnection(c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves at once when nothing is wrong", async () => {
    await expect(waitForConnection()).resolves.toBeUndefined();
  });
});

describe("withTimeout: disarm and dispose", () => {
  it("disarm stops the clock but keeps following the caller's abort", () => {
    const parent = new AbortController();
    const d = withTimeout(parent.signal, 1000);
    d.disarm();
    vi.advanceTimersByTime(5000);
    // The response arrived; the deadline no longer applies.
    expect(d.signal.aborted).toBe(false);
    expect(d.timedOut()).toBe(false);
    // But a body that is still streaming stops when the caller cancels.
    parent.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(false);
  });

  it("dispose lets go of the caller's signal", () => {
    const parent = new AbortController();
    const d = withTimeout(parent.signal, 1000);
    d.dispose();
    parent.abort();
    expect(d.signal.aborted).toBe(false);
  });
});

describe("the health probe", () => {
  /** A fetch that hangs until it is aborted, like a connection behind a dead router. */
  function hungFetch() {
    const signals: AbortSignal[] = [];
    const f = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          if (init?.signal) {
            signals.push(init.signal);
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }
        }),
    );
    return { f, signals };
  }

  it("gives up on a probe after 5 s and tries again, instead of hanging until the browser gives up", async () => {
    markUnreachable();
    const { f, signals } = hungFetch();
    const answers = new Response("{}");
    f.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          if (init?.signal) {
            signals.push(init.signal);
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }
        }),
    );
    f.mockImplementationOnce(async () => answers);
    vi.stubGlobal("fetch", f);

    let resolved = false;
    void waitForConnection().then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(2_000); // first probe starts, then hangs
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200); // 5 s after it began
    expect(signals[0]?.aborted).toBe(true);
    expect(resolved).toBe(false);

    // The next probe is 4 s later and finds the server.
    await vi.advanceTimersByTimeAsync(4_100);
    expect(f).toHaveBeenCalledTimes(2);
    expect(resolved).toBe(true);
    vi.unstubAllGlobals();
  });

  it("cancels a probe that is still in flight when the browser says it is online", async () => {
    markUnreachable();
    const { f, signals } = hungFetch();
    vi.stubGlobal("fetch", f);
    const p = waitForConnection();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals[0]?.aborted).toBe(false);
    window.dispatchEvent(new Event("online"));
    await expect(p).resolves.toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
    vi.unstubAllGlobals();
  });

  it("cancels it when the caller gives up too", async () => {
    markUnreachable();
    const { f, signals } = hungFetch();
    vi.stubGlobal("fetch", f);
    const c = new AbortController();
    const p = waitForConnection(c.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    c.abort();
    expect(await p).toMatchObject({ name: "AbortError" });
    expect(signals[0]?.aborted).toBe(true);
    vi.unstubAllGlobals();
  });

  it("treats any answer, even an error page, as the server being back", async () => {
    markUnreachable();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    const p = waitForConnection();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
