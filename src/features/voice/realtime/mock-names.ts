// Just the names, so the transport factory can check ?mockRealtime=<name>
// without importing the mock code itself (that stays a lazy chunk).

export const MOCK_SCENARIOS = [
  "normal-turn",
  "barge-in",
  "late-transcription",
  "failed-transcription",
  "text-turn",
  "error",
  "unknown-event",
  "budget",
  "grounding",
] as const;

export type MockScenarioName = (typeof MOCK_SCENARIOS)[number];

export function isMockScenario(
  v: string | null | undefined,
): v is MockScenarioName {
  return v != null && (MOCK_SCENARIOS as readonly string[]).includes(v);
}

/**
 * Scripted network trouble for the mock transport (?mockNet=<name>). Only the
 * first transport of a page misbehaves, so a reconnect can succeed (or, with
 * "dead", keep failing).
 */
export const MOCK_NET_SCENARIOS = [
  "drop-recover",
  "drop-timeout",
  "failed",
  "expired",
  "dead",
] as const;

export type MockNetName = (typeof MOCK_NET_SCENARIOS)[number];

export function isMockNet(v: string | null | undefined): v is MockNetName {
  return v != null && (MOCK_NET_SCENARIOS as readonly string[]).includes(v);
}
