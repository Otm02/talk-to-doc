import "server-only";
import {
  dayKey,
  systemClock,
  type Clock,
  type DocumentStore,
  type JsonValue,
  type DailyCountResult,
  type RateLimiter,
  type RateResult,
  type RateRule,
  type StateAdapters,
} from "./types";

// Local dev and tests only. env.ts refuses this driver on Vercel.

export function createMemoryDocumentStore(
  clock: Clock = systemClock,
): DocumentStore {
  const items = new Map<string, { doc: JsonValue; expiresAt: number }>();
  return {
    async put(id, doc, ttlMs) {
      items.set(id, {
        doc: structuredClone(doc),
        expiresAt: clock.now() + ttlMs,
      });
    },
    async get(id) {
      const item = items.get(id);
      if (!item) return null;
      if (item.expiresAt <= clock.now()) {
        items.delete(id);
        return null;
      }
      return structuredClone(item.doc);
    },
    async delete(id) {
      items.delete(id);
    },
  };
}

export function createMemoryRateLimiter(
  clock: Clock = systemClock,
): RateLimiter {
  const hits = new Map<string, number[]>();
  const daily = new Map<string, number>();
  return {
    async countDaily(key, cap): Promise<DailyCountResult> {
      const day = dayKey(clock.now());
      // Only today matters, so older days are dropped instead of piling up.
      for (const k of daily.keys()) if (!k.endsWith(`:${day}`)) daily.delete(k);
      const id = `${key}:${day}`;
      const count = daily.get(id) ?? 0;
      if (count >= cap) return { allowed: false, count, remaining: 0 };
      daily.set(id, count + 1);
      return { allowed: true, count: count + 1, remaining: cap - count - 1 };
    },
    async limit(key, rule: RateRule): Promise<RateResult> {
      const now = clock.now();
      const recent = (hits.get(key) ?? []).filter(
        (t) => t > now - rule.windowMs,
      );
      if (recent.length >= rule.max) {
        hits.set(key, recent);
        const oldest = recent[0] ?? now;
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: oldest + rule.windowMs - now,
        };
      }
      recent.push(now);
      hits.set(key, recent);
      return {
        allowed: true,
        remaining: rule.max - recent.length,
        retryAfterMs: 0,
      };
    },
  };
}

export function createMemoryAdapters(
  clock: Clock = systemClock,
): StateAdapters {
  return {
    documents: createMemoryDocumentStore(clock),
    rateLimiter: createMemoryRateLimiter(clock),
  };
}
