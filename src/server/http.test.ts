import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notFound } from "next/navigation";
import { catalogError } from "./errors";
import { ERROR_CATALOG } from "@/lib/errors/catalog";
import { handle } from "./http";

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  const other = vi.fn();
  vi.spyOn(console, "error").mockImplementation(other);
  vi.spyOn(console, "warn").mockImplementation(other);
  vi.spyOn(console, "log").mockImplementation(other);
});
afterEach(() => vi.restoreAllMocks());

const req = (url = "https://app.test/api/x?secret=in-the-url") =>
  new Request(url, { method: "POST", body: "document text in the body" });

const ndjson = (parts: string[], onPull?: () => void) =>
  new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = parts.shift();
        onPull?.();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    }),
    { headers: { "content-type": "application/x-ndjson; charset=utf-8" } },
  );

async function drain(res: Response): Promise<string> {
  return await res.text();
}

describe("handle: the request log", () => {
  it("writes one line with exactly request id, route, status and duration", async () => {
    const res = await handle("thing", () => Response.json({ ok: true }))(req());

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0] ?? "");
    expect(Object.keys(logged).sort()).toEqual([
      "durationMs",
      "requestId",
      "route",
      "status",
    ]);
    expect(logged.route).toBe("thing");
    expect(logged.status).toBe(200);
    expect(logged.durationMs).toBeGreaterThanOrEqual(0);
    expect(logged.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("adds the transcript provider when the handler reports one", async () => {
    await handle("yt", (_req, _id, meta) => {
      meta.provider = "supadata";
      return Response.json({});
    })(req());
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ provider: "supadata" });
  });

  it("logs the status and the catalog code of an AppError, not its message", async () => {
    const res = await handle("thing", () => {
      throw catalogError("rate_limited", { retryAfterSeconds: 7 });
    })(req());

    expect(res.status).toBe(429);
    const logged = JSON.parse(lines[0] ?? "");
    expect(logged).toMatchObject({ status: 429, code: "rate_limited" });
    expect(lines[0]).not.toContain(ERROR_CATALOG.rate_limited.message);
  });

  it("logs an unexpected error as internal, with nothing it said", async () => {
    await handle("thing", () => {
      throw new Error("pdf.js said: document text");
    })(req());
    const logged = JSON.parse(lines[0] ?? "");
    expect(logged).toMatchObject({ status: 500, code: "internal" });
    expect(lines[0]).not.toContain("document text");
  });

  it("never logs the URL, the body, or what an unexpected error said", async () => {
    const res = await handle("thing", async (r) => {
      await r.text();
      throw new Error("pdf.js said: document text in the body /srv/key sk-abc");
    })(req());

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal" } });
    const everything = [
      ...lines,
      ...vi.mocked(console.error).mock.calls.flat().map(String),
    ].join("\n");
    expect(everything).not.toContain("in-the-url");
    expect(everything).not.toContain("document text");
    expect(everything).not.toContain("sk-abc");
    expect(everything).not.toContain("/srv/key");
    expect(console.error).not.toHaveBeenCalled();
  });

  describe("streamed responses", () => {
    it("are logged when the body ends, not when the head is ready", async () => {
      const res = await handle("stream", () => ndjson(['{"a":1}\n']))(req());
      expect(lines).toEqual([]);
      expect(await drain(res)).toBe('{"a":1}\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        route: "stream",
        status: 200,
      });
    });

    it("carry a failure that happens after the 200 as its code", async () => {
      const res = await handle("stream", (_r, _id, meta) =>
        ndjson(['{"a":1}\n'], () => {
          meta.code = "pdf_no_text";
        }),
      )(req());
      await drain(res);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        status: 200,
        code: "pdf_no_text",
      });
    });

    it("are logged once, also when the client goes away", async () => {
      const res = await handle("stream", () =>
        ndjson(['{"a":1}\n', '{"b":2}\n']),
      )(req());
      const reader = res.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      await reader?.cancel().catch(() => undefined);
      expect(lines).toHaveLength(1);
    });

    it("keep the headers, including the request id", async () => {
      const res = await handle("stream", () => ndjson([]))(req());
      expect(res.headers.get("content-type")).toContain("ndjson");
      expect(res.headers.get("x-request-id")).toBeTruthy();
      await drain(res);
    });

    it("leave a JSON response alone", async () => {
      const res = await handle("json", () => Response.json({ ok: true }))(
        req(),
      );
      expect(lines).toHaveLength(1);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("lets Next's own control-flow errors through, unlogged and unmapped", async () => {
    // notFound() throws the signal Next uses to render a 404 (and the build
    // uses a sibling signal to learn a route is dynamic). Turning it into a
    // JSON 500 would break both.
    await expect(
      handle("thing", () => {
        notFound();
      })(req()),
    ).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(lines).toEqual([]);
  });
});
