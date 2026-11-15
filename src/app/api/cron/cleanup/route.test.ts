import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/server/env";
import { ORPHAN_UPLOAD_AGE_MS } from "@/server/ingest/pdf/limits";
import type { StateAdapters } from "@/server/state";
import { createMemoryAdapters } from "@/server/state/memory";

const holder = vi.hoisted(() => ({
  state: undefined as StateAdapters | undefined,
}));
vi.mock("@/server/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/state")>()),
  getState: () => {
    if (!holder.state) throw new Error("test state not set");
    return holder.state;
  },
}));
const blob = vi.hoisted(() => ({ list: vi.fn(), del: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

import { GET } from "./route";

const SECRET = "cron-secret-0123456789";
const TOKEN = "vercel_blob_rw_teststore_secretpart";
const NOW = Date.UTC(2026, 10, 15, 3, 0, 0);

interface Listed {
  pathname: string;
  url: string;
  uploadedAt: Date;
}
const entry = (pathname: string, ageMs: number): Listed => ({
  pathname,
  url: `https://teststore.private.blob.vercel-storage.com/${pathname}`,
  uploadedAt: new Date(NOW - ageMs),
});
const HOUR = 60 * 60_000;

let ipCounter = 0;
function call(auth?: string, ip?: string) {
  ipCounter += 1;
  return GET(
    new Request("https://app.test/api/cron/cleanup", {
      headers: {
        "x-forwarded-for": ip ?? `198.51.100.${ipCounter}`,
        ...(auth !== undefined && { authorization: auth }),
      },
    }),
  );
}
const authed = (ip?: string) => call(`Bearer ${SECRET}`, ip);

beforeEach(() => {
  holder.state = createMemoryAdapters();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("UPLOAD_MODE", "blob");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
  vi.stubEnv("CRON_SECRET", SECRET);
  for (const name of ["VERCEL", "VERCEL_ENV"]) vi.stubEnv(name, "");
  resetEnvCacheForTests();
  blob.list.mockReset();
  blob.del.mockReset();
  blob.list.mockResolvedValue({ blobs: [], hasMore: false });
  blob.del.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe("GET /api/cron/cleanup: who may call it", () => {
  it.each([
    ["no Authorization header", undefined],
    ["an empty bearer", "Bearer "],
    ["the wrong secret", "Bearer not-the-secret"],
    ["the secret without Bearer", SECRET],
    ["the secret with another scheme", `Basic ${SECRET}`],
  ])("refuses %s with 401 and touches nothing", async (_name, header) => {
    const res = await call(header);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.del).not.toHaveBeenCalled();
  });

  it("refuses everybody when CRON_SECRET is not set, even an empty bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    resetEnvCacheForTests();
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    expect(blob.list).not.toHaveBeenCalled();
  });

  it("rate limits guesses: after 5 a minute the answer is 429, whatever the secret", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 5; i++) {
      expect((await call("Bearer wrong", ip)).status).toBe(401);
    }
    const res = await authed(ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(blob.list).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/cleanup: what it deletes", () => {
  it("deletes only uploads/*.pdf older than an hour", async () => {
    const old = entry("uploads/old-Ab12.pdf", 2 * HOUR);
    const justOver = entry("uploads/over-Cd34.pdf", ORPHAN_UPLOAD_AGE_MS + 1);
    blob.list.mockResolvedValue({
      blobs: [
        old,
        justOver,
        entry("uploads/fresh-Ef56.pdf", 5 * 60_000),
        entry("uploads/exactly-Gh78.pdf", ORPHAN_UPLOAD_AGE_MS),
        entry("other/old-Ij90.pdf", 9 * HOUR),
        entry("uploads/notes.txt", 9 * HOUR),
        entry("uploads/sub/dir.pdf", 9 * HOUR),
        entry("uploads/has space.pdf", 9 * HOUR),
      ],
      hasMore: false,
    });

    const res = await authed();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(blob.del).toHaveBeenCalledTimes(1);
    expect(blob.del.mock.calls[0]?.[0]).toEqual([old.url, justOver.url]);
    expect(blob.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "uploads/", token: TOKEN }),
    );
  });

  it("deletes in batches and follows the cursor", async () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        entry(`uploads/${prefix}${i}.pdf`, 3 * HOUR),
      );
    blob.list
      .mockResolvedValueOnce({
        blobs: many("a", 250),
        hasMore: true,
        cursor: "next",
      })
      .mockResolvedValueOnce({ blobs: many("b", 3), hasMore: false });

    const res = await authed();

    expect(await res.json()).toEqual({ deleted: 253 });
    expect(blob.list.mock.calls[1]?.[0]).toMatchObject({ cursor: "next" });
    expect(blob.del.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([
      100, 100, 50, 3,
    ]);
  });

  it("stops after a bounded number of pages, however many there are", async () => {
    blob.list.mockResolvedValue({ blobs: [], hasMore: true, cursor: "more" });
    await authed();
    expect(blob.list).toHaveBeenCalledTimes(5);
  });

  it("does nothing when there is nothing old", async () => {
    blob.list.mockResolvedValue({
      blobs: [entry("uploads/fresh-Ab12.pdf", 60_000)],
      hasMore: false,
    });
    expect(await (await authed()).json()).toEqual({ deleted: 0 });
    expect(blob.del).not.toHaveBeenCalled();
  });

  it("does nothing outside blob mode", async () => {
    vi.stubEnv("UPLOAD_MODE", "direct");
    resetEnvCacheForTests();
    const res = await authed();
    expect(await res.json()).toEqual({ deleted: 0 });
    expect(blob.list).not.toHaveBeenCalled();
  });

  it("answers a Blob failure with the generic error, not its message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    blob.list.mockRejectedValue(new Error(`boom ${TOKEN}`));
    const res = await authed();
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toContain("internal");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("boom");
  });
});
