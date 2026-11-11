import "server-only";
import { getEnv } from "../env";
import { createMemoryAdapters } from "./memory";
import { createUpstashAdapters, createUpstashRedis } from "./upstash";
import type { StateAdapters } from "./types";

let cached: StateAdapters | undefined;

/**
 * Upstash when its env vars exist, otherwise memory (local and tests only;
 * env.ts refuses that combination on Vercel). The memory fallback is
 * per-process by design.
 */
export function getState(): StateAdapters {
  if (cached) return cached;
  const env = getEnv();
  cached = env.upstash
    ? createUpstashAdapters(
        createUpstashRedis(env.upstash.url, env.upstash.token),
      )
    : createMemoryAdapters();
  return cached;
}

export type * from "./types";
