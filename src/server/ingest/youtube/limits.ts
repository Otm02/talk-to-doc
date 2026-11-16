import "server-only";
import type { RateRule } from "../../state";

export const YOUTUBE_INGEST_RATE: RateRule = { max: 10, windowMs: 60_000 };

// Supadata's free plan is 100 credits a month and a lookup costs one. The
// counter is per UTC day. 3 a day was too tight for a review: a handful of
// different videos in one sitting hit `youtube_quota`. 15 a day is a ceiling on
// one day's burst, not a promise about the month: 100 credits last about a week
// of days that all reach the cap. The 24 h transcript cache below is what keeps
// ordinary use well under it.
export const SUPADATA_DAILY_KEY = "supadata-lookups";
export const SUPADATA_DAILY_CAP = 15;

// Cached by video and language so repeated tests, smoke runs and demos do not
// spend Supadata credits. A day, because captions of a published video do not
// change and the Upstash free plan holds a few dozen of these easily.
export const TRANSCRIPT_CACHE_TTL_MS = 24 * 60 * 60_000;
// Upstash's free plan rejects requests over 1 MB; stay well under.
export const TRANSCRIPT_CACHE_MAX_BYTES = 500_000;

// Direct fetching works from a home IP and mostly fails from cloud IPs. On
// Vercel, with Supadata behind it, fail fast instead of making the user wait.
export const DIRECT_TIMEOUT_MS = 15_000;
export const DIRECT_FAST_FAIL_MS = 3_000;

export const SUPADATA_TIMEOUT_MS = 15_000;
export const SUPADATA_POLL_INTERVAL_MS = 1_000;
export const SUPADATA_POLL_CAP_MS = 30_000;
export const OEMBED_TIMEOUT_MS = 3_000;

/** Caption XML is a few hundred KB for a long talk; this is a sanity cap. */
export const MAX_RESPONSE_CHARS = 10_000_000;

export const PARAGRAPH_SECONDS = 30;

// SPEC §5.2: longer than 6 h or 1.5 M characters is refused outright.
export const MAX_DURATION_SEC = 6 * 3600;
export const MAX_TRANSCRIPT_CHARS = 1_500_000;

export const DEFAULT_LANG = "en";
