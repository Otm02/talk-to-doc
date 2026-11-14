import "server-only";
import type { RateRule } from "../state";

// Five session starts per IP per ten minutes: enough to retry a few times,
// too few for a loop to run up a bill.
export const SESSION_IP_RATE: RateRule = { max: 5, windowMs: 10 * 60_000 };

/** Key for RateLimiter.countDaily / peekDaily; one counter for the whole app. */
export const DAILY_SESSION_KEY = "session-starts";

export const MAX_HISTORY_TURNS = 30;
/** Generous for 30 turns of 4,000 characters; far below any platform cap. */
export const MAX_SESSION_BODY_BYTES = 512 * 1024;
