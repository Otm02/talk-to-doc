import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/server/env";
import {
  CRON_RATE,
  INGEST_RATE,
  UPLOAD_TOKEN_RATE,
} from "@/server/ingest/pdf/limits";
import { YOUTUBE_INGEST_RATE } from "@/server/ingest/youtube/limits";
import { HEALTH_RATE } from "@/server/security/limits";
import { SESSION_IP_RATE } from "@/server/session/limits";
import type { RateRule, StateAdapters } from "@/server/state";
import { createMemoryAdapters } from "@/server/state/memory";
import { LimiterUnavailableError } from "@/server/state/types";
import { GET as cronCleanup } from "./cron/cleanup/route";
import { GET as health } from "./health/route";
import { POST as ingestPdf } from "./ingest/pdf/route";
import { POST as ingestYoutube } from "./ingest/youtube/route";
import { POST as session } from "./realtime/session/route";
import { POST as uploadToken } from "./upload/token/route";

// T-03 / T-08: every public route goes through the RateLimiter adapter, a 429
// carries its wait twice, and a limiter that cannot answer refuses instead of
// letting traffic through.

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

interface RouteCase {
  /** Path under src/app/api, as the file system has it. */
  dir: string;
  call: (req: Request) => Promise<Response>;
  rule: RateRule;
  method: "GET" | "POST";
}

const ROUTES: RouteCase[] = [
  { dir: "health", call: health, rule: HEALTH_RATE, method: "GET" },
  { dir: "cron/cleanup", call: cronCleanup, rule: CRON_RATE, method: "GET" },
  {
    dir: "realtime/session",
    call: session,
    rule: SESSION_IP_RATE,
    method: "POST",
  },
  { dir: "ingest/pdf", call: ingestPdf, rule: INGEST_RATE, method: "POST" },
  {
    dir: "ingest/youtube",
    call: ingestYoutube,
    rule: YOUTUBE_INGEST_RATE,
    method: "POST",
  },
  {
    dir: "upload/token",
    call: uploadToken,
    rule: UPLOAD_TOKEN_RATE,
    method: "POST",
  },
];

function request(route: RouteCase, ip: string): Request {
  return new Request(`https://app.test/api/${route.dir}`, {
    method: route.method,
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    // Deliberately useless: the limiter runs before the body is looked at.
    ...(route.method === "POST" && { body: "{}" }),
  });
}

beforeEach(() => {
  holder.state = createMemoryAdapters();
  vi.stubEnv("UPLOAD_MODE", "blob");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_secret");
  vi.stubEnv("OPENAI_API_KEY", "");
  for (const name of ["VERCEL", "VERCEL_ENV", "VOICE_ENABLED"]) {
    vi.stubEnv(name, "");
  }
  resetEnvCacheForTests();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

describe("every API route is limited", () => {
  const apiDir = path.join(import.meta.dirname);

  it("this table covers every route.ts, so a new route cannot ship unlimited", () => {
    const onDisk = routeFiles(apiDir)
      .map((f) => path.relative(apiDir, path.dirname(f)).replaceAll("\\", "/"))
      .sort();
    expect(onDisk).toEqual(ROUTES.map((r) => r.dir).sort());
  });

  it.each(ROUTES)("$dir goes through handle() and the limiter", ({ dir }) => {
    const source = readFileSync(path.join(apiDir, dir, "route.ts"), "utf-8");
    expect(source).toMatch(/=\s*handle\(\s*"/);
  });
});

describe.each(ROUTES)("$dir: over the limit", (route) => {
  const ip = "203.0.113.50";

  it(`refuses call ${route.rule.max + 1} with 429, Retry-After and retryAfterSec`, async () => {
    for (let i = 0; i < route.rule.max; i += 1) {
      const res = await route.call(request(route, ip));
      expect(res.status, `call ${i + 1} must not be limited yet`).not.toBe(429);
    }

    const res = await route.call(request(route, ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      error: { code: string; message: string; retryAfterSec?: number };
      requestId: string;
    };
    expect(body.error.code).toBe("rate_limited");
    const header = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(header)).toBe(true);
    expect(header).toBeGreaterThanOrEqual(1);
    expect(header).toBeLessThanOrEqual(Math.ceil(route.rule.windowMs / 1000));
    // Same number in both places: the client countdown reads the body.
    expect(body.error.retryAfterSec).toBe(header);
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });

  it("counts clients separately", async () => {
    for (let i = 0; i < route.rule.max; i += 1) {
      await route.call(request(route, "198.51.100.1"));
    }
    const other = await route.call(request(route, "198.51.100.2"));
    expect(other.status).not.toBe(429);
  });
});

describe.each(ROUTES)("$dir: limiter down", (route) => {
  it("refuses with 503 service_busy instead of letting the call through", async () => {
    const down = new LimiterUnavailableError(new Error("redis down"));
    const base = createMemoryAdapters();
    holder.state = {
      ...base,
      rateLimiter: {
        limit: () => Promise.reject(down),
        countDaily: () => Promise.reject(down),
        peekDaily: () => Promise.reject(down),
      },
    };

    const res = await route.call(request(route, "203.0.113.60"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("service_busy");
    expect(JSON.stringify(body)).not.toContain("redis");
  });
});
