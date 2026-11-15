import "server-only";
import type { RateLimiter } from "../../state";
import { SUPADATA_DAILY_CAP, SUPADATA_DAILY_KEY } from "./limits";
import { TranscriptError } from "./provider";

/**
 * Keeps Supadata's free credits from being spent by one visitor sending new
 * video ids. Counts every lookup that is about to be made (cache hits never
 * get here) and refuses once the day's share is gone. PROVIDER_QUOTA is not
 * retryable, so the chain stops there and the user sees `youtube_quota`.
 */
export function createSupadataGuard(limiter: RateLimiter): () => Promise<void> {
  return async () => {
    const today = await limiter.countDaily(
      SUPADATA_DAILY_KEY,
      SUPADATA_DAILY_CAP,
    );
    if (!today.allowed) throw new TranscriptError("PROVIDER_QUOTA");
  };
}
