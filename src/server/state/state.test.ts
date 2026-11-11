import { describe } from "vitest";
import { runStateContract, type Harness } from "./contract";
import { createMemoryAdapters } from "./memory";
import { createUpstashAdapters, createUpstashRedis } from "./upstash";

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
