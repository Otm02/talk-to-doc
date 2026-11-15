import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOffline,
  markUnreachable,
  resetConnectivityForTests,
} from "@/lib/net/connectivity";
import { StreamBrokenError } from "./ingest-error";
import { readIngestEvents } from "./ndjson-reader";
import {
  PDF_ANSWER_TIMEOUT_MS,
  YOUTUBE_TIMEOUT_MS,
  getUploadMode,
  ingestPdf,
  ingestYoutube,
  resetUploadModeForTests,
  retryAfter,
} from "./upload-client";

describe("retryAfter", () => {
  it("prefers retryAfterSec from the error body", () => {
    expect(
      retryAfter({ error: { code: "rate_limited", retryAfterSec: 538 } }, "72"),
    ).toBe(538);
  });

  it("falls back to the Retry-After header", () => {
    expect(retryAfter({ error: { code: "rate_limited" } }, "72")).toBe(72);
    expect(retryAfter(null, "2.5")).toBe(3);
    expect(retryAfter("<html>", "10")).toBe(10);
  });

  it("ignores unusable values", () => {
    expect(
      retryAfter({ error: { retryAfterSec: "soon" } }, null),
    ).toBeUndefined();
    expect(retryAfter({ error: { retryAfterSec: -1 } }, "0")).toBeUndefined();
    expect(retryAfter({ error: null }, "abc")).toBeUndefined();
    expect(retryAfter(undefined, null)).toBeUndefined();
  });

  it("caps absurd waits so the retry button cannot be parked for days", () => {
    expect(retryAfter({ error: { retryAfterSec: 1e12 } }, null)).toBe(86_400);
    expect(retryAfter(null, "1e12")).toBe(3_600);
    expect(retryAfter(null, "  ")).toBeUndefined();
  });
});

describe("ingestYoutube: timeouts and the one retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Node has no navigator.onLine; the browser always does.
    vi.stubGlobal("navigator", { onLine: true, language: "en-US" });
    resetConnectivityForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const ok = () =>
    new Response("{}\n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  const refusal = (status: number, code: string) =>
    new Response(JSON.stringify({ error: { code, message: "x" } }), { status });

  async function settled<T>(p: Promise<T>, ms = 5_000): Promise<T> {
    const guarded = p.then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    );
    await vi.advanceTimersByTimeAsync(ms);
    const r = await guarded;
    if ("e" in r) throw r.e;
    return r.v;
  }

  it("tries once more when the first call got no answer, and says nothing if the second works", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchSpy);
    const body = await settled(
      ingestYoutube("https://youtu.be/x", new AbortController().signal),
    );
    expect(body).toBeInstanceOf(ReadableStream);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("tries once more after a 502 from the provider chain", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(refusal(502, "youtube_failed"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchSpy);
    await settled(
      ingestYoutube("https://youtu.be/x", new AbortController().signal),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry, and marks the server unreachable when nothing answered", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchSpy);
    const error = await settled(
      ingestYoutube("https://youtu.be/x", new AbortController().signal),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "youtube_failed", noAnswer: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(isOffline()).toBe(true);
  });

  it.each([
    ["youtube_blocked", 503],
    ["youtube_quota", 503],
    ["youtube_no_transcript", 422],
    ["rate_limited", 429],
  ])("never repeats %s", async (code, status) => {
    const fetchSpy = vi.fn().mockResolvedValue(refusal(status, code));
    vi.stubGlobal("fetch", fetchSpy);
    const error = await settled(
      ingestYoutube("https://youtu.be/x", new AbortController().signal),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, noAnswer: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an answer of any kind clears the unreachable mark", async () => {
    markUnreachable();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(refusal(429, "rate_limited")),
    );
    await settled(
      ingestYoutube("https://youtu.be/x", new AbortController().signal),
    ).catch(() => {});
    expect(isOffline()).toBe(false);
  });

  it("treats a call with no answer inside 45 s as no answer", async () => {
    const fetchSpy = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const error = await settled(
      ingestYoutube("https://youtu.be/x", new AbortController().signal),
      YOUTUBE_TIMEOUT_MS * 2 + 5_000,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ noAnswer: true, message: "Timed out" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops at once, without a retry, when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const p = ingestYoutube("https://youtu.be/x", controller.signal);
    const guarded = p.catch((e: unknown) => e);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await guarded).toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(isOffline()).toBe(false);
  });
});

describe("getUploadMode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetUploadModeForTests();
    resetConnectivityForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks again after a failure instead of caching it, with one retry inside", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json({ uploadMode: "direct" }));
    vi.stubGlobal("fetch", fetchSpy);
    const p = getUploadMode();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe("direct");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fails with upload_failed and forgets the failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("x")));
    const p = getUploadMode().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toMatchObject({ code: "upload_failed", noAnswer: true });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ uploadMode: "blob" })),
    );
    await expect(getUploadMode()).resolves.toBe("blob");
  });

  it("rejects a health answer with no usable mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: true })),
    );
    const p = getUploadMode().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toMatchObject({ code: "upload_failed" });
  });
});

describe("Cancel stops a body that is already streaming", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { onLine: true, language: "en-US" });
    resetConnectivityForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("aborting after the headers arrived cancels the body, not just the request", async () => {
    const parent = new AbortController();
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("{}\n"));
          // What a browser does when its fetch is aborted mid-body.
          init?.signal?.addEventListener("abort", () =>
            c.error(new DOMException("Aborted", "AbortError")),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchSpy);

    const stream = await ingestYoutube("https://youtu.be/x", parent.signal);
    const reader = stream.getReader();
    await reader.read(); // the first line arrives
    const next = reader.read().catch((e: unknown) => e);
    parent.abort();
    expect(await next).toMatchObject({ name: "AbortError" });
  });
});

describe("a direct-mode upload (XHR)", () => {
  class FakeXhr {
    static HEADERS_RECEIVED = 2;
    static instances: FakeXhr[] = [];
    readyState = 0;
    status = 0;
    responseText = "";
    responseType = "";
    upload: { onprogress: unknown; onload: (() => void) | null } = {
      onprogress: null,
      onload: null,
    };
    onreadystatechange: (() => void) | null = null;
    onprogress: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    send() {
      FakeXhr.instances.push(this);
    }
    abort() {
      this.onabort?.();
    }
    getResponseHeader() {
      return null;
    }
    // test controls
    answer() {
      this.readyState = 2;
      this.status = 200;
      this.onreadystatechange?.();
    }
    chunk(text: string) {
      this.responseText += text;
      this.onprogress?.();
    }
  }

  const file = () =>
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "a.pdf", {
      type: "application/pdf",
    });
  const line = (v: unknown) => `${JSON.stringify(v)}\n`;
  const meta = { documentId: "d", title: "T", sourceType: "pdf", pages: 120 };

  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("navigator", { onLine: true, language: "en-US" });
    resetConnectivityForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a connection that breaks mid-stream keeps the pages that arrived and is not 'offline'", async () => {
    const p = ingestPdf(file(), "direct", new AbortController().signal);
    const xhr = FakeXhr.instances[0];
    xhr?.answer();
    const stream = await p;

    const events: string[] = [];
    const reading = (async () => {
      for await (const e of readIngestEvents(stream, "upload_failed")) {
        events.push(e.type);
      }
    })().catch((e: unknown) => e);
    xhr?.chunk(line(meta) + line({ page: 1, text: "a" }));
    await new Promise((r) => setTimeout(r, 0));
    xhr?.onerror?.();

    const error = await reading;
    expect(error).toBeInstanceOf(StreamBrokenError);
    // What came before the break was delivered, so the screen can keep it.
    expect(events).toEqual(["meta", "page"]);
    // The server was answering: this is not a device that lost its link.
    expect(isOffline()).toBe(false);
  });

  it("an error before any answer is a request nobody answered", async () => {
    const p = ingestPdf(file(), "direct", new AbortController().signal);
    const caught = p.catch((e: unknown) => e);
    FakeXhr.instances[0]?.onerror?.();
    const error = await caught;
    expect(error).toMatchObject({ code: "upload_failed", noAnswer: true });
    expect(error).not.toBeInstanceOf(StreamBrokenError);
    expect(isOffline()).toBe(true);
  });

  it("a server that never answers after the file is up counts as no answer", async () => {
    vi.useFakeTimers();
    const p = ingestPdf(file(), "direct", new AbortController().signal);
    const caught = p.catch((e: unknown) => e);
    FakeXhr.instances[0]?.upload.onload?.();
    await vi.advanceTimersByTimeAsync(PDF_ANSWER_TIMEOUT_MS + 1);
    expect(await caught).toMatchObject({
      code: "upload_failed",
      noAnswer: true,
      message: "Timed out",
    });
    expect(isOffline()).toBe(true);
  });

  it("the caller cancelling is an abort, and not a failure", async () => {
    const controller = new AbortController();
    const p = ingestPdf(file(), "direct", controller.signal);
    const caught = p.catch((e: unknown) => e);
    controller.abort();
    expect(await caught).toMatchObject({ name: "AbortError" });
    expect(isOffline()).toBe(false);
  });

  it("cancelling while pages are streaming errors the stream with an abort", async () => {
    const controller = new AbortController();
    const p = ingestPdf(file(), "direct", controller.signal);
    FakeXhr.instances[0]?.answer();
    const stream = await p;
    const reader = stream.getReader();
    const next = reader.read().catch((e: unknown) => e);
    controller.abort();
    expect(await next).toMatchObject({ name: "AbortError" });
  });
});
