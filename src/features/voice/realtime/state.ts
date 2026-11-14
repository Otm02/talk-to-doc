import type { EndReason, FailureCode, MicFailure } from "./failure";
import { EMPTY_USAGE, type UsageTotals } from "./usage";

export type Mode = "voice" | "text";

export type ConnectionState =
  | { status: "idle" }
  | { status: "requestingMic" }
  | { status: "connecting"; phase: "minting" | "negotiating" }
  | { status: "connected" }
  | { status: "reconnecting"; since: number }
  | { status: "ended"; reason: EndReason }
  | {
      status: "failed";
      code: FailureCode;
      /** Seconds to wait before trying again, when the server said so (429). */
      retryAfterSeconds?: number;
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
  muted: boolean;
  activity: Activity;
  items: Record<string, TranscriptItem>;
  /** Visible item ids in conversation order. Derived from `items`. */
  order: string[];
  epoch: number;
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
  muted: false,
  activity: "listening",
  items: {},
  order: [],
  epoch: 0,
  arrivalSeq: 0,
  response: { activeId: null, audioId: null },
  pending: {},
  usage: EMPTY_USAGE,
  notice: null,
  diagnostics: { unknown: 0, malformed: 0, byType: {} },
};
