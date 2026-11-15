import { describe, expect, it } from "vitest";
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

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

if (url && token) {
  runStateContract("upstash", (): Harness => ({
    adapters: createUpstashAdapters(createUpstashRedis(url, token)),
    advance: (ms) => new Promise((r) => setTimeout(r, ms)),
    canJumpDays: false,
  }));
} else {
  describe.skip("state contract: upstash (no UPSTASH_REDIS_REST_* in env)", () => {});
}
