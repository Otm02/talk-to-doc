import "server-only";
import {
  dayKey,
  systemClock,
  type Clock,
  type DocumentStore,
  type JsonValue,
  type RateLimiter,
  type RateResult,
  type RateRule,
  type StateAdapters,
  type UsageLedger,
  type UsageTotals,
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
  return {
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

export function createMemoryUsageLedger(
  clock: Clock = systemClock,
): UsageLedger {
  const spendByDay = new Map<string, number>();
  const sessionsByDay = new Map<string, number>();
  let totalSpend = 0;
  let totalSessions = 0;
  return {
    async addSpend(usd) {
      const day = dayKey(clock.now());
      spendByDay.set(day, (spendByDay.get(day) ?? 0) + usd);
      totalSpend += usd;
    },
    async addSession() {
      const day = dayKey(clock.now());
      sessionsByDay.set(day, (sessionsByDay.get(day) ?? 0) + 1);
      totalSessions += 1;
    },
    async totals(): Promise<UsageTotals> {
      const day = dayKey(clock.now());
      return {
        todaySpendUsd: spendByDay.get(day) ?? 0,
        totalSpendUsd: totalSpend,
        todaySessions: sessionsByDay.get(day) ?? 0,
        totalSessions,
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
    ledger: createMemoryUsageLedger(clock),
  };
}
