import "server-only";
import type { RateRule } from "../../state";

export const YOUTUBE_INGEST_RATE: RateRule = { max: 10, windowMs: 60_000 };

// Cached by video and language so repeated tests and demos do not spend
// Supadata credits (100 a month on the free plan).
export const TRANSCRIPT_CACHE_TTL_MS = 60 * 60_000;
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
