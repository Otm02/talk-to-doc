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
] as const;

export type MockScenarioName = (typeof MOCK_SCENARIOS)[number];

export function isMockScenario(
  v: string | null | undefined,
): v is MockScenarioName {
  return v != null && (MOCK_SCENARIOS as readonly string[]).includes(v);
}
