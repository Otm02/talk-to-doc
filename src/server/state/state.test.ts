import { afterAll, describe, expect, it } from "vitest";
import { runStateContract, type Harness } from "./contract";
import { createMemoryAdapters } from "./memory";
import { secondsUntilNextUtcDay } from "./types";
import { createUpstashAdapters, createUpstashRedis } from "./upstash";

describe("secondsUntilNextUtcDay", () => {
  it("counts down to the next UTC midnight and is never 0", () => {
    expect(secondsUntilNextUtcDay(Date.UTC(2026, 10, 14, 23, 59, 18))).toBe(42);
    expect(secondsUntilNextUtcDay(Date.UTC(2026, 10, 14, 12, 0, 0))).toBe(
      12 * 3600,
    );
    // Exactly midnight is the start of a full day, not "now".
    expect(secondsUntilNextUtcDay(Date.UTC(2026, 10, 15, 0, 0, 0))).toBe(
      86_400,
    );
    expect(
      secondsUntilNextUtcDay(Date.UTC(2026, 10, 14, 23, 59, 59, 900)),
    ).toBe(1);
  });
});

runStateContract("memory", (): Harness => {
  let now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const clock = { now: () => now };
  return {
    adapters: createMemoryAdapters(clock),
    advance: async (ms) => {
      now += ms;
    },
    canJumpDays: true,
  };
});

// The live suite writes real keys, and a developer's shell or .env.local often
// holds the production Upstash credentials. So credentials alone never start
// it: it needs RUN_LIVE_UPSTASH_TESTS=1 as well, it writes only under its own
// `ttd-test:<timestamp>` prefix (production's is `ttd`), and it deletes
// everything it wrote afterwards.
const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const optedIn = process.env.RUN_LIVE_UPSTASH_TESTS === "1";

if (url && token && optedIn) {
  const redis = createUpstashRedis(url, token);
  const prefix = `ttd-test:${Date.now()}`;

  afterAll(async () => {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, {
        match: `${prefix}:*`,
        count: 200,
      });
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  });

  runStateContract("upstash", (): Harness => ({
    adapters: createUpstashAdapters(redis, undefined, prefix),
    advance: (ms) => new Promise((r) => setTimeout(r, ms)),
    canJumpDays: false,
  }));
} else {
  const why =
    url && token
      ? "set RUN_LIVE_UPSTASH_TESTS=1 to run against Upstash"
      : "no UPSTASH_REDIS_REST_* in env";
  describe.skip(`state contract: upstash (${why})`, () => {});
}
