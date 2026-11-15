import type { EndReason, FailureCode, MicFailure } from "./failure";
import { EMPTY_USAGE, type UsageTotals } from "./usage";

export type Mode = "voice" | "text";

/**
 * Where an automatic reconnect is. "grace" waits for the link to heal on its
 * own; the others are the steps of getting a new session (reconnect.ts).
 */
export type ReconnectPhase =
  | "grace"
  | "waitingNetwork"
  | "backoff"
  | "minting"
  | "connecting"
  | "cooldown";

export type ConnectionState =
  | { status: "idle" }
  | { status: "requestingMic" }
  | {
      status: "connecting";
      /** waitingNetwork: the first mint got no answer and is waiting for the connection. */
      phase: "minting" | "negotiating" | "waitingNetwork";
    }
  | { status: "connected" }
  | {
      status: "reconnecting";
      since: number;
      phase: ReconnectPhase;
      /** 0 while still in grace; 1..maxAttempts once a new session is being sought. */
      attempt: number;
      maxAttempts: number;
      /** Deadline (ms since epoch) of a cooldown after a 429, for the live countdown. */
      retryAt?: number;
      /** This attempt follows a cooldown, so the cooldown was its backoff. */
      afterCooldown?: boolean;
    }
  | { status: "ended"; reason: EndReason }
  | {
      status: "failed";
      code: FailureCode;
      /**
       * The chat was live and the failure came out of rebuilding its link. A
       * retry then goes on with the same conversation instead of starting over.
       */
      fromReconnect?: boolean;
      /** Seconds to wait before trying again, when the server said so (429). */
      retryAfterSeconds?: number;
      /**
       * The same wait as a wall-clock deadline (ms since epoch), fixed when the
       * refusal arrived. Countdowns read this, so they cannot drift.
       */
      retryAt?: number;
    };

export type ConnectionStatus = ConnectionState["status"];

export type Activity =
  "listening" | "userSpeaking" | "thinking" | "assistantSpeaking";

export type ItemStatus =
  // user
  | "transcribing"
  | "transcriptionFailed"
  | "sending"
  | "sendFailed"
  // assistant
  | "streaming"
  | "interrupted"
  // both
  | "done";

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant";
  source: "voice" | "text";
  text: string;
  status: ItemStatus;
  responseId: string | null;
  /**
   * previous_item_id from the server: null = first in the conversation,
   * undefined = not told yet (the item arrived as a placeholder).
   */
  prev: string | null | undefined;
  /** Which connected session the item belongs to; sessions never interleave. */
  epoch: number;
  /** Arrival sequence: a tie-breaker, never the only ordering. */
  arrival: number;
}

export type PendingEntry =
  /** Our conversation.item.create for a typed message. */
  | { kind: "text"; itemId: string }
  /** Our response.create. */
  | { kind: "response" }
  /** Our response.cancel / output_audio_buffer.clear: errors are benign races. */
  | { kind: "benign" };

export type Notice =
  | { kind: "cap_warning"; secondsLeft: number }
  | { kind: "error"; code: string };

export interface Diagnostics {
  unknown: number;
  malformed: number;
  /** Event type -> count, for unknown events only. */
  byType: Record<string, number>;
}

export interface RealtimeState {
  connection: ConnectionState;
  mode: Mode;
  micIssue: MicFailure | null;
  /** "working" while a tap on "Try microphone again" is being checked. */
  micRetry: "idle" | "working";
  /** Retries that ended without a mic, in this chat. The coach opens on the first. */
  micRetryFails: number;
  muted: boolean;
  activity: Activity;
  items: Record<string, TranscriptItem>;
  /** Visible item ids in conversation order. Derived from `items`. */
  order: string[];
  epoch: number;
  /**
   * Epochs that began with an automatic or manual reconnect. The transcript
   * draws a "Reconnected" divider before the first item of each.
   */
  reconnectMarks: number[];
  /**
   * Counts chats, not sessions: a reconnect starts a new session (epoch) inside
   * the same chat, and the chat's timer must keep counting through it.
   */
  chatSeq: number;
  arrivalSeq: number;
  response: {
    /** Response between response.created and response.done. */
    activeId: string | null;
    /** Response whose audio is between output_audio_buffer started and stopped. */
    audioId: string | null;
  };
  pending: Record<string, PendingEntry>;
  usage: UsageTotals;
  notice: Notice | null;
  diagnostics: Diagnostics;
}

export const initialState: RealtimeState = {
  connection: { status: "idle" },
  mode: "voice",
  micIssue: null,
  micRetry: "idle",
  micRetryFails: 0,
  muted: false,
  activity: "listening",
  items: {},
  order: [],
  epoch: 0,
  reconnectMarks: [],
  chatSeq: 0,
  arrivalSeq: 0,
  response: { activeId: null, audioId: null },
  pending: {},
  usage: EMPTY_USAGE,
  notice: null,
  diagnostics: { unknown: 0, malformed: 0, byType: {} },
};
