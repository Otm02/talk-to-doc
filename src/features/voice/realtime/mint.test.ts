import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOffline, resetConnectivityForTests } from "@/lib/net/connectivity";
import {
  MINT_TIMEOUT_MS,
  MintError,
  mintSession,
  parseRetryAfter,
  retryAfterFrom,
} from "./mint";

const OK = {
  clientSecret: "ek_test_not_a_real_secret",
  expiresAt: 1_800_000_000,
  model: "gpt-realtime-2.1-mini",
  maxSessionSeconds: 300,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const mint = (res: () => Response | Promise<Response>) =>
  mintSession(
    "doc-1",
    new AbortController().signal,
    vi.fn(async () => res()) as unknown as typeof fetch,
  );

describe("mintSession", () => {
  it("posts only the document id and returns the validated body", async () => {
    const f = vi.fn(async () => json(OK));
    const signal = new AbortController().signal;
    const result = await mintSession(
      "doc-1",
      signal,
      f as unknown as typeof fetch,
    );
    expect(result).toEqual(OK);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/realtime/session");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", signal });
    expect(JSON.parse(String(init.body))).toEqual({ documentId: "doc-1" });
  });

  it.each([
    ["voice_disabled", 503],
    ["daily_limit", 429],
    ["rate_limited", 429],
    ["budget_exhausted", 503],
    ["doc_not_found", 404],
    ["session_upstream_busy", 503],
  ])("passes through the catalog code %s", async (code, status) => {
    await expect(
      mint(() => json({ error: { code, message: "x" } }, status)),
    ).rejects.toMatchObject({
      name: "MintError",
      code,
    });
  });

  it("shows a generic failure for a code it has no copy for", async () => {
    await expect(
      mint(() => json({ error: { code: "mystery" } }, 502)),
    ).rejects.toMatchObject({
      code: "session_connect_failed",
    });
    await expect(mint(() => json({ nope: true }, 502))).rejects.toMatchObject({
      code: "session_connect_failed",
    });
  });

  it("treats an error page that is not JSON as an internal error", async () => {
    await expect(
      mint(() => new Response("<html>oops</html>", { status: 502 })),
    ).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("rejects a success body that is not JSON or the wrong shape", async () => {
    await expect(
      mint(() => new Response("ok", { status: 200 })),
    ).rejects.toMatchObject({
      code: "session_connect_failed",
    });
    await expect(mint(() => json({ clientSecret: "" }))).rejects.toMatchObject({
      code: "session_connect_failed",
    });
    await expect(
      mint(() => json({ ...OK, maxSessionSeconds: 0 })),
    ).rejects.toBeInstanceOf(MintError);
  });

  it("names a request that never got an answer a network failure", async () => {
    await expect(
      mint(() => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toMatchObject({ code: "session_network_failed" });
  });

  it("lets our own abort through untouched", async () => {
    const controller = new AbortController();
    const abort = new DOMException("Aborted", "AbortError");
    const f = vi.fn(async () => {
      controller.abort();
      throw abort;
    });
    await expect(
      mintSession("doc-1", controller.signal, f as unknown as typeof fetch),
    ).rejects.toBe(abort);
  });
});

describe("Retry-After on a rate limit", () => {
  const limited = (header?: string) =>
    mint(
      () =>
        new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: header === undefined ? {} : { "retry-after": header },
        }),
    );

  it("keeps the wait the server asked for", async () => {
    await expect(limited("42")).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 42,
    });
  });

  it("prefers retryAfterSec from the body over the header", async () => {
    const res = () =>
      new Response(
        JSON.stringify({ error: { code: "rate_limited", retryAfterSec: 538 } }),
        { status: 429, headers: { "retry-after": "72" } },
      );
    await expect(mint(res)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 538,
    });
  });

  it("reads the body alone when a proxy dropped the header", async () => {
    const res = () =>
      new Response(
        JSON.stringify({
          error: { code: "daily_limit", retryAfterSec: 30_000 },
        }),
        { status: 429 },
      );
    await expect(mint(res)).rejects.toMatchObject({
      code: "daily_limit",
      retryAfterSeconds: 30_000,
    });
  });

  it("falls back to the header when the body value is unusable", () => {
    expect(retryAfterFrom(undefined, "42")).toBe(42);
    expect(retryAfterFrom(Number.NaN, "42")).toBe(42);
    expect(retryAfterFrom(2.2, null)).toBe(3);
    // A day at most, even if the body says more.
    expect(retryAfterFrom(999_999, null)).toBe(86_400);
    expect(retryAfterFrom(undefined, null)).toBeUndefined();
  });

  it("has no wait when the header is missing", async () => {
    const err = await limited().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MintError);
    expect((err as MintError).retryAfterSeconds).toBeUndefined();
  });

  it.each([
    ["30", 30],
    ["2.5", 3],
    ["99999", 3600],
    ["1", 1],
  ])("reads %s as %i seconds", (raw, expected) => {
    expect(parseRetryAfter(raw)).toBe(expected);
  });

  it.each([null, "", "  ", "0", "-5", "abc", "Infinity", "NaN"])(
    "ignores the unusable value %j",
    (raw) => {
      expect(parseRetryAfter(raw)).toBeUndefined();
    },
  );

  it("does not attach a wait to errors that are not rate limits", async () => {
    const err = await mint(
      () =>
        new Response(JSON.stringify({ error: { code: "internal" } }), {
          status: 500,
        }),
    ).catch((e: unknown) => e);
    expect((err as MintError).retryAfterSeconds).toBeUndefined();
  });

  describe("history", () => {
    const turn = (i: number) => ({
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      text: `turn ${i}`,
    });
    const sent = (f: ReturnType<typeof vi.fn>) =>
      JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body));

    it("sends no history key when there is none", async () => {
      const f = vi.fn(async () => json(OK));
      await mintSession("doc-1", new AbortController().signal, f as never, []);
      expect(sent(f)).toEqual({ documentId: "doc-1" });
    });

    it("sends the newest 30 turns, each cut to the server's limit, skipping blanks", async () => {
      const f = vi.fn(async () => json(OK));
      const turns = [
        ...Array.from({ length: 40 }, (_, i) => turn(i)),
        { role: "user" as const, text: "   " },
        { role: "assistant" as const, text: "x".repeat(5000) },
      ];
      await mintSession(
        "doc-1",
        new AbortController().signal,
        f as never,
        turns,
      );
      const body = sent(f);
      expect(body.history).toHaveLength(30);
      expect(body.history.at(-1).text).toHaveLength(4000);
      expect(body.history[0]).toEqual(turn(11));
    });
  });
});

describe("mintSession: the deadline", () => {
  /** A fetch that answers nothing until it is aborted, like a hung server. */
  const hung = () =>
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    resetConnectivityForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up after 15 s with a visible failure, not an offline one", async () => {
    const p = mintSession("doc-1", new AbortController().signal, hung()).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ code: "session_connect_failed" });
  });

  it("does not claim the device is offline: the server may simply be slow", async () => {
    const p = mintSession("doc-1", new AbortController().signal, hung()).catch(
      () => {},
    );
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS + 1);
    await p;
    expect(isOffline()).toBe(false);
  });

  it("a request that fails outright is still the network", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(
      mintSession("doc-1", new AbortController().signal, f),
    ).rejects.toMatchObject({ code: "session_network_failed" });
    expect(isOffline()).toBe(true);
  });

  it("a body that stalls after a 200 is a failure to retry, never a quiet second mint", async () => {
    const stalled = vi.fn(
      async (_url: string, init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            new Promise((_, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const p = mintSession("doc-1", new AbortController().signal, stalled).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS + 1);
    expect(await p).toMatchObject({ code: "session_connect_failed" });
    // The server did answer.
    expect(isOffline()).toBe(false);
  });

  it("the caller's own abort is passed through, not turned into a failure", async () => {
    const c = new AbortController();
    const p = mintSession("doc-1", c.signal, hung()).catch((e: unknown) => e);
    c.abort();
    expect(await p).toMatchObject({ name: "AbortError" });
  });
});
