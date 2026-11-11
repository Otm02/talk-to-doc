import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  dayKey,
  systemClock,
  type Clock,
  type DocumentStore,
  type JsonValue,
  type RateLimiter,
  type StateAdapters,
  type UsageLedger,
} from "./types";

const PREFIX = "ttd";
const TIMEOUT_MS = 2000;

export function createUpstashRedis(url: string, token: string): Redis {
  return new Redis({ url, token, automaticDeserialization: false });
}

export function createUpstashDocumentStore(redis: Redis): DocumentStore {
  const key = (id: string) => `${PREFIX}:doc:${id}`;
  return {
    async put(id, doc, ttlMs) {
      await redis.set(key(id), JSON.stringify(doc), {
        px: Math.max(1, Math.round(ttlMs)),
      });
    },
    async get(id) {
      const raw = await redis.get<string>(key(id));
      return raw === null ? null : (JSON.parse(raw) as JsonValue);
    },
    async delete(id) {
      await redis.del(key(id));
    },
  };
}

export function createUpstashRateLimiter(redis: Redis): RateLimiter {
  // @upstash/ratelimit fixes the rule at construction, so keep one per rule.
  const limiters = new Map<string, Ratelimit>();
  return {
    async limit(key, rule) {
      const id = `${rule.max}:${rule.windowMs}`;
      let rl = limiters.get(id);
      if (!rl) {
        rl = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(rule.max, `${rule.windowMs} ms`),
          prefix: `${PREFIX}:rl:${id}`,
          analytics: false,
          timeout: TIMEOUT_MS,
        });
        limiters.set(id, rl);
      }
      const res = await rl.limit(key);
      return {
        allowed: res.success,
        remaining: res.remaining,
        retryAfterMs: res.success ? 0 : Math.max(0, res.reset - Date.now()),
      };
    },
  };
}

export function createUpstashUsageLedger(
  redis: Redis,
  clock: Clock = systemClock,
): UsageLedger {
  const k = {
    spendDay: (d: string) => `${PREFIX}:usd:day:${d}`,
    spendTotal: `${PREFIX}:usd:total`,
    sessionsDay: (d: string) => `${PREFIX}:sessions:day:${d}`,
    sessionsTotal: `${PREFIX}:sessions:total`,
  };
  const num = (v: string | null) => (v === null ? 0 : Number(v));
  return {
    async addSpend(usd) {
      const day = dayKey(clock.now());
      await Promise.all([
        redis.incrbyfloat(k.spendDay(day), usd),
        redis.incrbyfloat(k.spendTotal, usd),
      ]);
    },
    async addSession() {
      const day = dayKey(clock.now());
      await Promise.all([
        redis.incr(k.sessionsDay(day)),
        redis.incr(k.sessionsTotal),
      ]);
    },
    async totals() {
      const day = dayKey(clock.now());
      const [spendDay, spendTotal, sessDay, sessTotal] = await redis.mget<
        (string | null)[]
      >(k.spendDay(day), k.spendTotal, k.sessionsDay(day), k.sessionsTotal);
      return {
        todaySpendUsd: num(spendDay ?? null),
        totalSpendUsd: num(spendTotal ?? null),
        todaySessions: num(sessDay ?? null),
        totalSessions: num(sessTotal ?? null),
      };
    },
  };
}

export function createUpstashAdapters(
  redis: Redis,
  clock: Clock = systemClock,
): StateAdapters {
  return {
    documents: createUpstashDocumentStore(redis),
    rateLimiter: createUpstashRateLimiter(redis),
    ledger: createUpstashUsageLedger(redis, clock),
  };
}
