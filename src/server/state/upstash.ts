import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  dayKey,
  systemClock,
  LimiterUnavailableError,
  type Clock,
  type DocumentStore,
  type JsonValue,
  type DailyCountResult,
  type RateLimiter,
  type RateResult,
  type RateRule,
  type StateAdapters,
} from "./types";

const PREFIX = "ttd";
// The limiter answers within this or the request is refused.
const TIMEOUT_MS = 2000;
// Per Redis call, for everything that is not a limiter check (a stored
// document can be a few hundred KB). Without it the client waits on a hung
// connection, and retries five times with growing pauses, until the platform
// kills the function.
const REDIS_CALL_TIMEOUT_MS = 5000;

export function createUpstashRedis(url: string, token: string): Redis {
  return new Redis({
    url,
    token,
    automaticDeserialization: false,
    retry: { retries: 1 },
    signal: () => AbortSignal.timeout(REDIS_CALL_TIMEOUT_MS),
  });
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

/**
 * Any failure of the limiter's own store, or no answer within `timeoutMs`,
 * means "cannot count": fail closed. The race is ours, not the client's, so it
 * covers the daily counters as well as the sliding window.
 */
async function closed<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("rate limiter timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    throw new LimiterUnavailableError(err);
  } finally {
    clearTimeout(timer);
  }
}

export function createUpstashRateLimiter(
  redis: Redis,
  clock: Clock = systemClock,
  timeoutMs: number = TIMEOUT_MS,
): RateLimiter {
  // @upstash/ratelimit fixes the rule at construction, so keep one per rule.
  const limiters = new Map<string, Ratelimit>();
  return {
    countDaily: (key, cap): Promise<DailyCountResult> =>
      closed(timeoutMs, async () => {
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
      }),
    peekDaily: (key) =>
      closed(timeoutMs, async () => {
        const raw = await redis.get<string | number>(
          `${PREFIX}:daily:${key}:${dayKey(clock.now())}`,
        );
        // automaticDeserialization is off, so a counter comes back as a string.
        const count = raw === null ? 0 : Number(raw);
        return Number.isFinite(count) ? count : 0;
      }),
    limit: (key, rule) => closed(timeoutMs, () => slidingWindow(key, rule)),
  };

  async function slidingWindow(
    key: string,
    rule: RateRule,
  ): Promise<RateResult> {
    const id = `${rule.max}:${rule.windowMs}`;
    let rl = limiters.get(id);
    if (!rl) {
      rl = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(rule.max, `${rule.windowMs} ms`),
        prefix: `${PREFIX}:rl:${id}`,
        analytics: false,
        timeout: timeoutMs,
      });
      limiters.set(id, rl);
    }
    const res = await rl.limit(key);
    // On a timeout the library answers success: true so that a slow store
    // lets traffic through. That is exactly what must not happen here.
    if (res.reason === "timeout") throw new Error("rate limit check timed out");
    return {
      allowed: res.success,
      remaining: res.remaining,
      retryAfterMs: res.success ? 0 : Math.max(0, res.reset - Date.now()),
    };
  }
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
