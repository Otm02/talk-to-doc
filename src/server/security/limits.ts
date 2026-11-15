import "server-only";
import type { RateRule } from "../state";

// /api/health answers without touching any upstream, but it is still a public
// route, so it gets a limit like the rest. The browser calls it once to learn
// the upload mode and while it waits for the network to come back (a probe
// that backs off), so real use is a handful a minute; the limit is a ceiling
// for a shared address, not a target. Each call costs an Upstash command, so
// do not point a monitor at it more often than every few minutes.
export const HEALTH_RATE: RateRule = { max: 120, windowMs: 60_000 };
