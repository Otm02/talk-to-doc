import type { Redis } from "@upstash/redis";
import { describe, expect, it } from "vitest";
import { LimiterUnavailableError } from "./types";
import { createUpstashRateLimiter } from "./upstash";

// The limiter must never answer "allowed" because it could not count. These
// run against a stand-in for Redis, so they need no credentials.

const RULE = { max: 5, windowMs: 60_000 };

function redisWith(overrides: Record<string, unknown>): Redis {
  return overrides as unknown as Redis;
}

const hangs = () => new Promise<never>(() => undefined);
const fails = () => Promise.reject(new Error("connect ECONNREFUSED"));
// pipeline().incr(k).expire(k, ttl).exec(): only exec talks to the network.
const brokenPipeline = () => {
  const chain = { incr: () => chain, expire: () => chain, exec: fails };
  return chain;
};

describe("Upstash rate limiter: fail closed", () => {
  it("refuses when the sliding-window check times out", async () => {
    const limiter = createUpstashRateLimiter(
      redisWith({ evalsha: hangs, eval: hangs }),
      undefined,
      20,
    );
    await expect(limiter.limit("k", RULE)).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
  });

  it("refuses when Redis errors", async () => {
    const limiter = createUpstashRateLimiter(
      redisWith({ evalsha: fails, eval: fails }),
    );
    await expect(limiter.limit("k", RULE)).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
  });

  it("refuses when the daily counter cannot be read or bumped", async () => {
    const limiter = createUpstashRateLimiter(
      redisWith({ get: fails, pipeline: brokenPipeline }),
    );
    await expect(limiter.peekDaily("k")).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
    await expect(limiter.countDaily("k", 5)).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
  });

  it("refuses when the daily counter hangs, not only the sliding window", async () => {
    const hangingPipeline = () => {
      const chain = { incr: () => chain, expire: () => chain, exec: hangs };
      return chain;
    };
    const limiter = createUpstashRateLimiter(
      redisWith({ get: hangs, pipeline: hangingPipeline }),
      undefined,
      20,
    );
    await expect(limiter.peekDaily("k")).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
    await expect(limiter.countDaily("k", 5)).rejects.toBeInstanceOf(
      LimiterUnavailableError,
    );
  });

  it("keeps the cause for the server, and puts no upstream text in the message", async () => {
    const limiter = createUpstashRateLimiter(redisWith({ get: fails }));
    const err = await limiter.peekDaily("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimiterUnavailableError);
    expect((err as Error).message).not.toContain("ECONNREFUSED");
    expect((err as Error).cause).toBeInstanceOf(Error);
  });
});
