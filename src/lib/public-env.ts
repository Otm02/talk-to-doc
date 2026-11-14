// The only client-side reader of process.env, besides src/server/env.ts.
// NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so
// each one must be written as a literal `process.env.NAME` expression. They
// are never secrets.

export const publicEnv = {
  isDev: process.env.NODE_ENV !== "production",
  /** `mock` in e2e builds: lets ?mockRealtime=<scenario> replace OpenAI. */
  realtimeTransport:
    process.env.NEXT_PUBLIC_REALTIME_TRANSPORT === "mock" ? "mock" : "webrtc",
} as const;
