import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  dayKey,
  systemClock,
  type Clock,
  type DocumentStore,
  type JsonValue,
  type DailyCountResult,
  type RateLimiter,
  type StateAdapters,
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

const DAILY_KEY_TTL_SECONDS = 48 * 60 * 60;

export function createUpstashRateLimiter(
  redis: Redis,
  clock: Clock = systemClock,
): RateLimiter {
  // @upstash/ratelimit fixes the rule at construction, so keep one per rule.
  const limiters = new Map<string, Ratelimit>();
  return {
    async countDaily(key, cap): Promise<DailyCountResult> {
      const k = `${PREFIX}:daily:${key}:${dayKey(clock.now())}`;
      // INCR is atomic, so concurrent starts cannot both take the last slot.
      // The TTL outlives the day so a late hit never recreates an immortal key.
      const [count] = await redis
        .pipeline()
        .incr(k)
        .expire(k, DAILY_KEY_TTL_SECONDS)
        .exec<[number, number]>();
      return {
        allowed: count <= cap,
        count,
        remaining: Math.max(0, cap - count),
      };
    },
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

export function createUpstashAdapters(
  redis: Redis,
  clock: Clock = systemClock,
): StateAdapters {
  return {
    documents: createUpstashDocumentStore(redis),
    rateLimiter: createUpstashRateLimiter(redis, clock),
  };
}
