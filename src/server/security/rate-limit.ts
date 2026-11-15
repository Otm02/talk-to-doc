import "server-only";
import { createHmac } from "node:crypto";
import { getEnv } from "../env";
import { catalogError } from "../errors";
import { getState, type RateRule } from "../state";
import { normalizeClientIp } from "./client-ip";

/**
 * Keyed hash (HMAC with IP_HASH_SALT) of the client's address, so raw IPs
 * never become Redis keys or log lines, and the key cannot be reversed by
 * hashing every IPv4 address. IPv6 clients count per /64. On Vercel the
 * platform sets x-forwarded-for, so a client cannot choose its own value; off
 * Vercel (local, CI) everything shares one bucket when no header is present.
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = normalizeClientIp(
    forwarded || req.headers.get("x-real-ip")?.trim() || "unknown",
  );
  return createHmac("sha256", getEnv().ipHashSalt)
    .update(ip)
    .digest("hex")
    .slice(0, 16);
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
