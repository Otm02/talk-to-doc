import { describe, expect, it } from "vitest";
import type { StateAdapters } from "./types";

export interface Harness {
  adapters: StateAdapters;
  /** Moves time forward: fake clock for memory, a real sleep for Upstash. */
  advance(ms: number): Promise<void>;
  /** Only the fake clock can jump across midnight. */
  canJumpDays: boolean;
}

/** One suite that every implementation must pass. Each call gets fresh state. */
export function runStateContract(
  name: string,
  make: () => Harness | Promise<Harness>,
) {
  describe(`state contract: ${name}`, () => {
    describe("DocumentStore", () => {
      it("returns what was stored and null for unknown ids", async () => {
        const { adapters } = await make();
        const id = crypto.randomUUID();
        await adapters.documents.put(
          id,
          { title: "A", pages: ["x", "y"] },
          60_000,
        );
        expect(await adapters.documents.get(id)).toEqual({
          title: "A",
          pages: ["x", "y"],
        });
        expect(await adapters.documents.get(crypto.randomUUID())).toBeNull();
      });

      it("expires after the TTL", async () => {
        const { adapters, advance } = await make();
        const id = crypto.randomUUID();
        await adapters.documents.put(id, "hello", 1000);
        await advance(500);
        expect(await adapters.documents.get(id)).toBe("hello");
        await advance(700);
        expect(await adapters.documents.get(id)).toBeNull();
      });

      it("deletes, and deleting a missing id is fine", async () => {
        const { adapters } = await make();
        const id = crypto.randomUUID();
        await adapters.documents.put(id, 1, 60_000);
        await adapters.documents.delete(id);
        expect(await adapters.documents.get(id)).toBeNull();
        await expect(adapters.documents.delete(id)).resolves.toBeUndefined();
      });
    });

    describe("RateLimiter", () => {
      const rule = { max: 2, windowMs: 1000 };

      it("allows up to max, then blocks with a retry hint", async () => {
        const { adapters } = await make();
        const key = crypto.randomUUID();
        expect((await adapters.rateLimiter.limit(key, rule)).allowed).toBe(
          true,
        );
        const second = await adapters.rateLimiter.limit(key, rule);
        expect(second.allowed).toBe(true);
        expect(second.remaining).toBe(0);
        const third = await adapters.rateLimiter.limit(key, rule);
        expect(third.allowed).toBe(false);
        expect(third.retryAfterMs).toBeGreaterThan(0);
        expect(third.retryAfterMs).toBeLessThanOrEqual(rule.windowMs);
      });

      it("keeps keys independent", async () => {
        const { adapters } = await make();
        const a = crypto.randomUUID();
        const b = crypto.randomUUID();
        await adapters.rateLimiter.limit(a, { max: 1, windowMs: 1000 });
        expect(
          (await adapters.rateLimiter.limit(a, { max: 1, windowMs: 1000 }))
            .allowed,
        ).toBe(false);
        expect(
          (await adapters.rateLimiter.limit(b, { max: 1, windowMs: 1000 }))
            .allowed,
        ).toBe(true);
      });

      it("allows again once the window has slid past", async () => {
        const { adapters, advance } = await make();
        const key = crypto.randomUUID();
        await adapters.rateLimiter.limit(key, rule);
        await adapters.rateLimiter.limit(key, rule);
        expect((await adapters.rateLimiter.limit(key, rule)).allowed).toBe(
          false,
        );
        await advance(2100);
        expect((await adapters.rateLimiter.limit(key, rule)).allowed).toBe(
          true,
        );
      });
    });

    describe("RateLimiter.countDaily", () => {
      it("allows up to the cap, then blocks", async () => {
        const { adapters } = await make();
        const key = crypto.randomUUID();
        const first = await adapters.rateLimiter.countDaily(key, 2);
        expect(first).toEqual({ allowed: true, count: 1, remaining: 1 });
        const second = await adapters.rateLimiter.countDaily(key, 2);
        expect(second).toEqual({ allowed: true, count: 2, remaining: 0 });
        const third = await adapters.rateLimiter.countDaily(key, 2);
        expect(third.allowed).toBe(false);
        expect(third.remaining).toBe(0);
      });

      it("blocks everything when the cap is 0", async () => {
        const { adapters } = await make();
        const res = await adapters.rateLimiter.countDaily(
          crypto.randomUUID(),
          0,
        );
        expect(res.allowed).toBe(false);
        expect(res.remaining).toBe(0);
      });

      it("keeps keys independent", async () => {
        const { adapters } = await make();
        const a = crypto.randomUUID();
        await adapters.rateLimiter.countDaily(a, 1);
        expect((await adapters.rateLimiter.countDaily(a, 1)).allowed).toBe(
          false,
        );
        expect(
          (await adapters.rateLimiter.countDaily(crypto.randomUUID(), 1))
            .allowed,
        ).toBe(true);
      });

      it("starts fresh on the next UTC day", async () => {
        const h = await make();
        if (!h.canJumpDays) return;
        const key = crypto.randomUUID();
        await h.adapters.rateLimiter.countDaily(key, 1);
        expect((await h.adapters.rateLimiter.countDaily(key, 1)).allowed).toBe(
          false,
        );
        await h.advance(24 * 60 * 60 * 1000);
        expect(await h.adapters.rateLimiter.countDaily(key, 1)).toEqual({
          allowed: true,
          count: 1,
          remaining: 0,
        });
      });
    });
  });
}
