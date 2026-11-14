import { describe, expect, it, vi } from "vitest";
import { MintError, mintSession, parseRetryAfter } from "./mint";

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

  it("turns a network failure into a connect failure", async () => {
    await expect(
      mint(() => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toMatchObject({ code: "session_connect_failed" });
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
});
