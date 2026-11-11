import "server-only";
import { createHash } from "node:crypto";
import { catalogError } from "../errors";
import { getState, type RateRule } from "../state";

/**
 * Hashed so raw IPs never become Redis keys or log lines. On Vercel the
 * platform sets x-forwarded-for, so a client cannot choose its own value; off
 * Vercel (local, CI) everything shares one bucket when no header is present.
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/** Throws rate_limited (429 with Retry-After) when `scope` is over `rule` for this client. */
export async function enforceRateLimit(
  req: Request,
  scope: string,
  rule: RateRule,
): Promise<void> {
  const result = await getState().rateLimiter.limit(
    `${scope}:${clientKey(req)}`,
    rule,
  );
  if (!result.allowed) {
    throw catalogError("rate_limited", {
      retryAfterSeconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)),
    });
  }
}
