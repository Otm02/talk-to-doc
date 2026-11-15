import type { RealtimeState } from "../realtime/state";

export type PillTone = "neutral" | "active" | "speaking" | "warning" | "error" | "ended";

export interface PillInfo {
  label: string;
  tone: PillTone;
}

/** One place that decides the status words. Pure, so every state is testable. */
export function statusInfo(state: RealtimeState): PillInfo {
  const c = state.connection;
  switch (c.status) {
    case "idle":
      return { label: "Ready", tone: "neutral" };
    case "requestingMic":
    case "connecting":
      return { label: "Connecting", tone: "neutral" };
    case "reconnecting":
      return { label: "Reconnecting", tone: "warning" };
    case "failed":
      return { label: "Offline", tone: "error" };
    case "ended":
      return { label: "Ended", tone: "ended" };
    case "connected":
      if (state.muted && state.mode === "voice") {
        return { label: "Muted", tone: "warning" };
      }
      switch (state.activity) {
        case "listening":
          return { label: "Listening", tone: "active" };
        case "userSpeaking":
          return { label: "You're speaking", tone: "active" };
        case "thinking":
          return { label: "Thinking", tone: "neutral" };
        case "assistantSpeaking":
          return { label: "Speaking", tone: "speaking" };
        default: {
          const unreachable: never = state.activity;
          return unreachable;
        }
      }
    default: {
      const unreachable: never = c;
      return unreachable;
    }
  }
}

export function isLive(state: RealtimeState): boolean {
  const s = state.connection.status;
  return s === "connected" || s === "reconnecting";
}

export function isInProgress(state: RealtimeState): boolean {
  const s = state.connection.status;
  return s === "requestingMic" || s === "connecting" || isLive(state);
}
