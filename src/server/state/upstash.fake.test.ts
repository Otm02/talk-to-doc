import type { Redis } from "@upstash/redis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStateContract, type Harness } from "./contract";
import { LimiterUnavailableError } from "./types";
import {
  createUpstashAdapters,
  createUpstashDocumentStore,
  createUpstashRateLimiter,
  createUpstashRedis,
} from "./upstash";

// The shared state contract needs a real Upstash database, so CI used to skip
// it and none of the adapter's success paths ran. This runs the same suite
// against stand-ins for the two things the adapter talks to: the Redis client
// (set, get, del, pipeline) and @upstash/ratelimit's sliding window. What it
// proves is OUR code: key names, TTLs, the cap arithmetic, the mapping of the
// library's answer, and failing closed. It does not prove Upstash itself.

const fakes = vi.hoisted(() => {
  interface Hit {
    at: number;
  }
  const windows = new Map<string, Hit[]>();
  const outcome: { reason?: "timeout" } = {};

  class FakeRatelimit {
    private readonly prefix: string;
    private readonly max: number;
    private readonly windowMs: number;
    constructor(opts: {
      prefix: string;
      limiter: { max: number; windowMs: number };
    }) {
      this.prefix = opts.prefix;
      this.max = opts.limiter.max;
      this.windowMs = opts.limiter.windowMs;
    }
    static slidingWindow(max: number, window: string) {
      return { max, windowMs: Number.parseInt(window, 10) };
    }
    async limit(key: string) {
      const now = Date.now();
      if (outcome.reason === "timeout") {
        // What the real library does when its own timeout fires.
        return { success: true, remaining: 0, reset: now, reason: "timeout" };
      }
      const id = `${this.prefix}:${key}`;
      const hits = (windows.get(id) ?? []).filter(
        (h) => h.at > now - this.windowMs,
      );
      const success = hits.length < this.max;
      if (success) hits.push({ at: now });
      windows.set(id, hits);
      const oldest = hits[0]?.at ?? now;
      return {
        success,
        remaining: Math.max(0, this.max - hits.length),
        reset: oldest + this.windowMs,
      };
    }
  }
  return { FakeRatelimit, windows, outcome };
});

vi.mock("@upstash/ratelimit", () => ({ Ratelimit: fakes.FakeRatelimit }));

interface Entry {
  value: string;
  expiresAt: number | null;
}

/** The handful of Redis commands the adapter issues, with TTLs on the fake clock. */
class FakeRedis {
  readonly data = new Map<string, Entry>();
  calls: string[] = [];

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  async set(key: string, value: string, opts: { px: number }) {
    this.calls.push(`set ${key} px=${opts.px}`);
    this.data.set(key, { value, expiresAt: Date.now() + opts.px });
    return "OK";
  }
  async get<T>(key: string): Promise<T | null> {
    return (this.live(key)?.value as T | undefined) ?? null;
  }
  async del(key: string) {
    this.calls.push(`del ${key}`);
    this.data.delete(key);
    return 1;
  }
  pipeline() {
    const ops: Array<() => number> = [];
    const chain = {
      incr: (k: string) => {
        ops.push(() => {
          const e = this.live(k);
          const n = (e ? Number(e.value) : 0) + 1;
          this.data.set(k, {
            value: String(n),
            expiresAt: e?.expiresAt ?? null,
          });
          return n;
        });
        return chain;
      },
      expire: (k: string, seconds: number) => {
        ops.push(() => {
          this.calls.push(`expire ${k} ${seconds}`);
          const e = this.live(k);
          if (e) e.expiresAt = Date.now() + seconds * 1000;
          return 1;
        });
        return chain;
      },
      exec: async () => ops.map((run) => run()),
    };
    return chain;
  }
}

const asRedis = (r: FakeRedis) => r as unknown as Redis;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 9, 12, 0, 0));
  fakes.windows.clear();
  delete fakes.outcome.reason;
});
afterEach(() => vi.useRealTimers());

runStateContract("upstash adapter on a fake Redis", (): Harness => ({
  adapters: createUpstashAdapters(asRedis(new FakeRedis())),
  advance: async (ms) => {
    vi.setSystemTime(Date.now() + ms);
  },
  canJumpDays: true,
}));

describe("Upstash adapter: what it writes", () => {
  it("stores a document as JSON under an environment prefix, with the TTL in ms", async () => {
    const redis = new FakeRedis();
    const store = createUpstashDocumentStore(asRedis(redis), "ttd-preview");
    await store.put("abc", { a: 1 }, 7_200_000);
    expect(redis.calls).toEqual(["set ttd-preview:doc:abc px=7200000"]);
    expect(redis.data.get("ttd-preview:doc:abc")?.value).toBe('{"a":1}');
    await store.delete("abc");
    expect(redis.calls).toContain("del ttd-preview:doc:abc");
  });

  it("never sets a zero or fractional TTL (Redis rejects it)", async () => {
    const redis = new FakeRedis();
    const store = createUpstashDocumentStore(asRedis(redis));
    await store.put("a", 1, 0);
    await store.put("b", 1, 1499.6);
    expect(redis.calls).toEqual([
      "set ttd:doc:a px=1",
      "set ttd:doc:b px=1500",
    ]);
  });

  it("keeps preview and production counters apart by prefix", async () => {
    const redis = new FakeRedis();
    const prod = createUpstashRateLimiter(asRedis(redis));
    const preview = createUpstashRateLimiter(
      asRedis(redis),
      undefined,
      undefined,
      "ttd-preview",
    );
    await prod.countDaily("session", 1);
    expect((await preview.countDaily("session", 1)).allowed).toBe(true);
    expect([...redis.data.keys()]).toEqual([
      "ttd:daily:session:2026-11-09",
      "ttd-preview:daily:session:2026-11-09",
    ]);
  });

  it("gives every daily key a TTL longer than the day, so none outlives it forever", async () => {
    const redis = new FakeRedis();
    const limiter = createUpstashRateLimiter(asRedis(redis));
    await limiter.countDaily("session", 5);
    expect(redis.calls).toContain("expire ttd:daily:session:2026-11-09 172800");
  });

  it("reads a garbled counter as zero rather than NaN", async () => {
    const redis = new FakeRedis();
    redis.data.set("ttd:daily:session:2026-11-09", {
      value: "not-a-number",
      expiresAt: null,
    });
    const limiter = createUpstashRateLimiter(asRedis(redis));
    expect(await limiter.peekDaily("session")).toBe(0);
  });
});

describe("Upstash adapter: the sliding window", () => {
  const rule = { max: 2, windowMs: 10_000 };

  it("reports the wait until the oldest hit leaves the window", async () => {
    const limiter = createUpstashRateLimiter(asRedis(new FakeRedis()));
    await limiter.limit("ip", rule);
    vi.setSystemTime(Date.now() + 4_000);
    await limiter.limit("ip", rule);
    const blocked = await limiter.limit("ip", rule);
    expect(blocked).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 6_000,
    });
  });

  it("reuses one limiter per rule and keeps different rules apart", async () => {
    const limiter = createUpstashRateLimiter(asRedis(new FakeRedis()));
    const other = { max: 1, windowMs: 10_000 };
    await limiter.limit("ip", other);
    expect((await limiter.limit("ip", other)).allowed).toBe(false);
    // Same key, other rule: its own bucket.
    expect((await limiter.limit("ip", rule)).allowed).toBe(true);
  });

  it("refuses when the library says its own timeout fired (it would say success)", async () => {
    fakes.outcome.reason = "timeout";
    const limiter = createUpstashRateLimiter(asRedis(new FakeRedis()));
    await expect(limiter.limit("ip", rule)).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
  });
});

describe("createUpstashRedis", () => {
  it("builds a client without touching the network", () => {
    expect(createUpstashRedis("https://example.upstash.io", "t")).toBeTruthy();
  });
});
