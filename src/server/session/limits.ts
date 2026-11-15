import "server-only";
import type { RateRule } from "../state";

// Fifteen session starts per IP per ten minutes. Minting a secret costs
// nothing, and several phones behind one address (or one phone on two
// browsers) share this bucket, so it only has to stop a loop. Actual spend is
// guarded by DAILY_SESSION_CAP and by OpenAI's hard limit on the key.
export const SESSION_IP_RATE: RateRule = { max: 15, windowMs: 10 * 60_000 };

/** Key for RateLimiter.countDaily / peekDaily; one counter for the whole app. */
export const DAILY_SESSION_KEY = "session-starts";

export const MAX_HISTORY_TURNS = 30;
/** Generous for 30 turns of 4,000 characters; far below any platform cap. */
export const MAX_SESSION_BODY_BYTES = 512 * 1024;
