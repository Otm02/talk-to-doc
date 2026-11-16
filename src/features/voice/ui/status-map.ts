import type { FailureCode } from "../realtime/failure";
import type { RealtimeState } from "../realtime/state";

export type PillTone =
  "neutral" | "active" | "speaking" | "warning" | "error" | "ended";

/** One name per pill, so the icon is chosen by meaning and never by its words. */
export type PillKind =
  | "ready"
  | "connecting"
  | "reconnecting"
  | "listening"
  | "userSpeaking"
  | "thinking"
  | "speaking"
  | "muted"
  | "typing"
  | "cooldown"
  | "dailyLimit"
  | "offline"
  | "unavailable"
  | "notConnected"
  | "ended";

export interface PillInfo {
  kind: PillKind;
  label: string;
  tone: PillTone;
}

/**
 * Why a chat is not running, said honestly. "Offline" is only for the
 * network: the device reports no link, or a request never got an answer. A
 * server that answered "wait" or "not today" is not offline, and saying so
 * sends the user to check a connection that is fine.
 */
function failedInfo(code: FailureCode, online: boolean): PillInfo {
  if (!online) return { kind: "offline", label: "Offline", tone: "error" };
  switch (code) {
    case "rate_limited":
      return { kind: "cooldown", label: "Cooldown", tone: "warning" };
    case "daily_limit":
      return {
        kind: "dailyLimit",
        label: "Daily limit reached",
        tone: "warning",
      };
    // A request that never got an answer. A dropped chat connection
    // (session_reconnect_failed) falls through to "Not connected": the link
    // may be fine and OpenAI may have hung up, and the offline branch above
    // already covers a device that really has no network.
    case "session_network_failed":
      return { kind: "offline", label: "Offline", tone: "error" };
    case "voice_disabled":
    case "budget_exhausted":
    // Our own limiter's store did not answer: not the chat's fault, and it
    // clears by itself.
    case "service_busy":
      return { kind: "unavailable", label: "Unavailable", tone: "warning" };
    default:
      return { kind: "notConnected", label: "Not connected", tone: "error" };
  }
}

/** One place that decides the status words. Pure, so every state is testable. */
export function statusInfo(state: RealtimeState, online = true): PillInfo {
  const c = state.connection;
  switch (c.status) {
    case "idle":
      return { kind: "ready", label: "Ready", tone: "neutral" };
    case "requestingMic":
      // The browser's permission prompt is up: say what it is waiting for.
      return {
        kind: "connecting",
        label: "Allow the microphone",
        tone: "neutral",
      };
    case "connecting":
      // A first start whose mint got no answer: said as it is, not as "Connecting".
      return c.phase === "waitingNetwork"
        ? { kind: "offline", label: "Offline", tone: "warning" }
        : { kind: "connecting", label: "Connecting", tone: "neutral" };
    case "reconnecting": {
      const phase = c.phase;
      switch (phase) {
        // Nothing is minted while the device has no link.
        case "waitingNetwork":
          return { kind: "offline", label: "Offline", tone: "warning" };
        // A 429 on the way back: the same word as for any other 429.
        case "cooldown":
          return { kind: "cooldown", label: "Cooldown", tone: "warning" };
        // The count is in the line under the header (ReconnectNotice), not the pill.
        case "grace":
        case "backoff":
        case "minting":
        case "connecting":
          return {
            kind: "reconnecting",
            label: "Reconnecting",
            tone: "warning",
          };
        default: {
          const unreachable: never = phase;
          return unreachable;
        }
      }
    }
    case "failed":
      return failedInfo(c.code, online);
    case "ended":
      return { kind: "ended", label: "Ended", tone: "ended" };
    case "connected":
      if (state.muted && state.mode === "voice") {
        return { kind: "muted", label: "Muted", tone: "warning" };
      }
      switch (state.activity) {
        case "listening":
          // Nothing is listening in a text chat: there is no mic.
          return state.mode === "text"
            ? { kind: "typing", label: "Ready", tone: "active" }
            : { kind: "listening", label: "Listening", tone: "active" };
        case "userSpeaking":
          return {
            kind: "userSpeaking",
            label: "You're speaking",
            tone: "active",
          };
        case "thinking":
          return { kind: "thinking", label: "Thinking", tone: "neutral" };
        case "assistantSpeaking":
          return { kind: "speaking", label: "Speaking", tone: "speaking" };
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
