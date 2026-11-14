import type { ServerEvent, WireItem } from "./events";
import { isBillingCode, type FailureCode, type MicFailure } from "./failure";
import {
  initialState,
  type Activity,
  type ConnectionState,
  type Mode,
  type Notice,
  type RealtimeState,
  type TranscriptItem,
} from "./state";
import { isHidden, visibleOrder } from "./transcript";
import { addResponseUsage, addTranscriptionUsage } from "./usage";

// The whole client-side protocol as a pure function: (state, action) => state.
// Server events, local commands and timers all arrive as actions; nothing
// here touches a clock, a transport or the DOM. Rules worth knowing:
//  - Items are keyed by id and ordered by previous_item_id, never by arrival.
//  - An interrupted answer keeps the words generated so far and is frozen:
//    later deltas and .done text for it are dropped.
//  - Only the *current* response (or the one whose audio is playing) may move
//    `activity`. Late events from an interrupted response change bookkeeping
//    only, so a barge-in never flickers back to "listening".

export type Action =
  | { type: "reset" }
  | { type: "server"; event: ServerEvent }
  | { type: "diagnostic"; kind: "unknown" | "malformed"; eventType?: string }
  | { type: "connection"; connection: ConnectionState }
  | { type: "mode"; mode: Mode; micIssue: MicFailure | null }
  | { type: "muted"; muted: boolean }
  | {
      type: "local-text";
      id: string;
      text: string;
      createEventId: string;
      responseEventId: string;
    }
  | { type: "local-text-failed"; id: string }
  | { type: "local-text-discard"; id: string }
  | { type: "local-stop" }
  | { type: "benign"; eventId: string }
  | { type: "notice"; notice: Notice | null };

const MAX_PENDING = 24;
const MAX_UNKNOWN_TYPES = 64;

// ---------------------------------------------------------------- items

function put(state: RealtimeState, item: TranscriptItem): RealtimeState {
  const old = state.items[item.id];
  const items = { ...state.items, [item.id]: item };
  const orderChanged =
    !old ||
    old.prev !== item.prev ||
    old.epoch !== item.epoch ||
    isHidden(old) !== isHidden(item);
  return {
    ...state,
    items,
    order: orderChanged ? visibleOrder(items) : state.order,
  };
}

interface Seed {
  role: TranscriptItem["role"];
  source: TranscriptItem["source"];
  status: TranscriptItem["status"];
  responseId?: string | null;
  text?: string;
}

/** Creates a placeholder when an event names an item we have not seen yet. */
function ensure(state: RealtimeState, id: string, seed: Seed): RealtimeState {
  if (state.items[id]) return state;
  const item: TranscriptItem = {
    id,
    role: seed.role,
    source: seed.source,
    text: seed.text ?? "",
    status: seed.status,
    responseId: seed.responseId ?? null,
    prev: undefined,
    epoch: state.epoch,
    arrival: state.arrivalSeq,
  };
  return put({ ...state, arrivalSeq: state.arrivalSeq + 1 }, item);
}

function patch(
  state: RealtimeState,
  id: string,
  change: Partial<TranscriptItem>,
): RealtimeState {
  const cur = state.items[id];
  return cur ? put(state, { ...cur, ...change }) : state;
}

function textOf(item: WireItem): string {
  const parts: string[] = [];
  for (const c of item.content ?? []) {
    const t = c.transcript ?? c.text;
    if (typeof t === "string" && t !== "") parts.push(t);
  }
  return parts.join("");
}

function applyPrev(
  state: RealtimeState,
  id: string,
  prevId: string | null | undefined,
  kind: "added" | "done",
): RealtimeState {
  const cur = state.items[id];
  if (!cur) return state;
  // `added` is authoritative; an absent link there means "first". On `done`
  // an absent link must not erase one we already have.
  if (prevId !== undefined) {
    return cur.prev === prevId ? state : patch(state, id, { prev: prevId });
  }
  return cur.prev === undefined && kind === "added"
    ? patch(state, id, { prev: null })
    : state;
}

/** Marks answers of the given responses interrupted, keeping their words. */
function interrupt(
  state: RealtimeState,
  responseIds: readonly string[],
  itemIds: readonly string[] = [],
): RealtimeState {
  let next = state;
  for (const it of Object.values(state.items)) {
    if (it.role !== "assistant" || it.status === "interrupted") continue;
    const byResponse =
      it.responseId !== null && responseIds.includes(it.responseId);
    if (byResponse || itemIds.includes(it.id)) {
      next = put(next, { ...it, status: "interrupted" });
    }
  }
  return next;
}

function rekey(state: RealtimeState, from: string, to: string): RealtimeState {
  const cur = state.items[from];
  if (!cur) return state;
  const { [from]: _removed, ...rest } = state.items;
  void _removed;
  const items = { ...rest, [to]: { ...cur, id: to } };
  const pending = { ...state.pending };
  for (const [k, v] of Object.entries(pending)) {
    if (v.kind === "text" && v.itemId === from)
      pending[k] = { ...v, itemId: to };
  }
  return { ...state, items, pending, order: visibleOrder(items) };
}

function dropPendingFor(state: RealtimeState, itemId: string): RealtimeState {
  const pending = { ...state.pending };
  let changed = false;
  for (const [k, v] of Object.entries(pending)) {
    if (v.kind === "text" && v.itemId === itemId) {
      delete pending[k];
      changed = true;
    }
  }
  return changed ? { ...state, pending } : state;
}

function addPending(
  state: RealtimeState,
  entries: Record<string, RealtimeState["pending"][string]>,
): RealtimeState {
  const merged = { ...state.pending, ...entries };
  const keys = Object.keys(merged);
  // Insertion order is arrival order; drop the oldest beyond the cap.
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PENDING))) {
    delete merged[k];
  }
  return { ...state, pending: merged };
}

function omitPending(state: RealtimeState, eventId: string): RealtimeState {
  const { [eventId]: _gone, ...rest } = state.pending;
  void _gone;
  return { ...state, pending: rest };
}

// -------------------------------------------------------------- activity

function setActivity(state: RealtimeState, activity: Activity): RealtimeState {
  return state.activity === activity ? state : { ...state, activity };
}

/** After a response or its audio ends: back to listening unless more is coming. */
function settleActivity(state: RealtimeState): RealtimeState {
  if (state.response.audioId !== null) return state;
  if (state.activity !== "thinking" && state.activity !== "assistantSpeaking") {
    return state;
  }
  return setActivity(
    state,
    state.response.activeId !== null ? "thinking" : "listening",
  );
}

// ------------------------------------------------------------ connection

function canTransition(
  from: ConnectionState["status"],
  to: ConnectionState["status"],
): boolean {
  switch (to) {
    case "idle":
      return from === "ended" || from === "failed";
    case "requestingMic":
      return from === "idle" || from === "ended" || from === "failed";
    case "connecting":
      return (
        from === "idle" ||
        from === "requestingMic" ||
        from === "connecting" ||
        from === "ended" ||
        from === "failed"
      );
    case "connected":
      return from === "connecting" || from === "reconnecting";
    case "reconnecting":
      return from === "connected";
    case "ended":
      return (
        from === "requestingMic" ||
        from === "connecting" ||
        from === "connected" ||
        from === "reconnecting"
      );
    case "failed":
      return (
        from === "requestingMic" ||
        from === "connecting" ||
        from === "connected" ||
        from === "reconnecting"
      );
    default: {
      const unreachable: never = to;
      return unreachable;
    }
  }
}

/** Whatever was in flight when the session stopped can no longer finish. */
function settleItems(state: RealtimeState): RealtimeState {
  let next = state;
  for (const it of Object.values(state.items)) {
    switch (it.status) {
      case "streaming":
        next = put(next, { ...it, status: "interrupted" });
        break;
      case "transcribing":
        next = put(next, { ...it, status: "transcriptionFailed" });
        break;
      case "sending":
        next = put(next, { ...it, status: "sendFailed" });
        break;
      case "transcriptionFailed":
      case "sendFailed":
      case "interrupted":
      case "done":
        break;
      default: {
        const unreachable: never = it.status;
        void unreachable;
      }
    }
  }
  return next;
}

function applyConnection(
  state: RealtimeState,
  connection: ConnectionState,
): RealtimeState {
  if (!canTransition(state.connection.status, connection.status)) return state;
  const base = { ...state, connection };
  switch (connection.status) {
    case "connected":
      return { ...base, activity: "listening", notice: null };
    case "ended":
    case "failed": {
      const settled = settleItems(base);
      return {
        ...settled,
        activity: "listening",
        response: { activeId: null, audioId: null },
        pending: {},
      };
    }
    case "idle":
    case "requestingMic":
    case "connecting":
    case "reconnecting":
      return base;
    default: {
      const unreachable: never = connection;
      return unreachable;
    }
  }
}

function fail(state: RealtimeState, code: FailureCode): RealtimeState {
  return applyConnection(state, { status: "failed", code });
}

// --------------------------------------------------------- server events

function onUserItem(
  state: RealtimeState,
  kind: "added" | "done",
  wire: WireItem,
  prevId: string | null | undefined,
): RealtimeState {
  const hasAudio = (wire.content ?? []).some((c) => c.type === "input_audio");
  const typed = wire.content?.find((c) => c.type === "input_text")?.text ?? "";
  let s = state;

  if (!s.items[wire.id] && !hasAudio && typed !== "") {
    // Fallback if the server ever re-ids a message we created ourselves.
    const local = Object.values(s.items).find(
      (it) => it.status === "sending" && it.text === typed,
    );
    if (local) s = rekey(s, local.id, wire.id);
  }

  if (!s.items[wire.id]) {
    const voice = hasAudio || typed === "";
    s = ensure(s, wire.id, {
      role: "user",
      source: voice ? "voice" : "text",
      status: voice ? "transcribing" : "done",
      text: voice ? "" : typed,
    });
  }
  s = applyPrev(s, wire.id, prevId, kind);

  const it = s.items[wire.id];
  if (!it || it.role !== "user") return s;
  if (it.status === "sending") {
    s = patch(s, wire.id, { status: "done" });
    return dropPendingFor(s, wire.id);
  }
  // The item can already carry its transcript when transcription is quick.
  const transcript = textOf(wire).trim();
  if (it.status === "transcribing" && hasAudio && transcript !== "") {
    s = patch(s, wire.id, { text: transcript, status: "done" });
  }
  return s;
}

function onAssistantItem(
  state: RealtimeState,
  kind: "added" | "done",
  wire: WireItem,
  prevId: string | null | undefined,
): RealtimeState {
  let s = ensure(state, wire.id, {
    role: "assistant",
    source: state.mode === "voice" ? "voice" : "text",
    status: "streaming",
    responseId: state.response.activeId,
  });
  s = applyPrev(s, wire.id, prevId, kind);
  const it = s.items[wire.id];
  if (!it || it.role !== "assistant") return s;
  if (it.responseId === null && s.response.activeId !== null) {
    s = patch(s, wire.id, { responseId: s.response.activeId });
  }
  if (kind === "done" && it.status === "streaming") {
    const fallback = it.text === "" ? textOf(wire) : it.text;
    s = patch(s, wire.id, {
      text: fallback,
      status: wire.status === "incomplete" ? "interrupted" : "done",
    });
  }
  return s;
}

function onItemEvent(
  state: RealtimeState,
  kind: "added" | "done",
  wire: WireItem,
  prevId: string | null | undefined,
): RealtimeState {
  if (wire.type !== undefined && wire.type !== "message") return state;
  switch (wire.role) {
    case "user":
      return onUserItem(state, kind, wire, prevId);
    case "assistant":
      return onAssistantItem(state, kind, wire, prevId);
    default:
      return state;
  }
}

function onAnswerDelta(
  state: RealtimeState,
  responseId: string,
  itemId: string,
  delta: string,
  source: TranscriptItem["source"],
): RealtimeState {
  let s = ensure(state, itemId, {
    role: "assistant",
    source,
    status: "streaming",
    responseId,
  });
  const it = s.items[itemId];
  if (!it || it.role !== "assistant") return s;
  // Frozen once interrupted: words generated after that were never heard.
  if (it.status !== "streaming" && it.status !== "done") return s;
  s = patch(s, itemId, {
    text: it.text + delta,
    source,
    responseId: it.responseId ?? responseId,
  });
  // Text mode has no audio buffer, so the first text is the "speaking" cue.
  if (source === "text" && s.activity === "thinking") {
    s = setActivity(s, "assistantSpeaking");
  }
  return s;
}

function onAnswerDone(
  state: RealtimeState,
  responseId: string,
  itemId: string,
  text: string,
  source: TranscriptItem["source"],
): RealtimeState {
  const s = ensure(state, itemId, {
    role: "assistant",
    source,
    status: "streaming",
    responseId,
  });
  const it = s.items[itemId];
  if (!it || it.role !== "assistant") return s;
  if (it.status !== "streaming" && it.status !== "done") return s;
  return patch(s, itemId, {
    text,
    source,
    responseId: it.responseId ?? responseId,
  });
}

function onResponseDone(
  state: RealtimeState,
  response: Extract<ServerEvent, { type: "response.done" }>["response"],
): RealtimeState {
  const errorCode = response.status_details?.error?.code ?? null;
  const errorType = response.status_details?.error?.type ?? null;
  let s: RealtimeState = {
    ...state,
    usage: addResponseUsage(state.usage, response.usage),
  };
  if (isBillingCode(errorCode) || isBillingCode(errorType)) {
    return fail(s, "budget_exhausted");
  }

  const outputIds = (response.output ?? [])
    .filter((o) => o.role === "assistant")
    .map((o) => o.id);
  for (const id of outputIds) {
    const it = s.items[id];
    if (it && it.responseId === null) {
      s = patch(s, id, { responseId: response.id });
    }
  }

  const status = response.status ?? "completed";
  if (
    status === "cancelled" ||
    status === "incomplete" ||
    status === "failed"
  ) {
    s = interrupt(s, [response.id], outputIds);
    if (status === "failed") {
      s = {
        ...s,
        notice: { kind: "error", code: errorCode ?? "response_failed" },
      };
    }
  } else {
    for (const it of Object.values(s.items)) {
      if (
        it.role === "assistant" &&
        it.responseId === response.id &&
        it.status === "streaming"
      ) {
        const wire = (response.output ?? []).find((o) => o.id === it.id);
        const fallback = it.text === "" && wire ? textOf(wire) : it.text;
        s = patch(s, it.id, { text: fallback, status: "done" });
      }
    }
  }

  if (s.response.activeId === response.id) {
    s = { ...s, response: { ...s.response, activeId: null } };
    s = settleActivity(s);
  }
  return s;
}

function onServerEvent(
  state: RealtimeState,
  event: ServerEvent,
): RealtimeState {
  switch (event.type) {
    case "session.created":
      // A new session is a new conversation: its items sort after older ones.
      return { ...state, epoch: state.epoch + 1 };
    case "session.updated":
      return state;

    case "input_audio_buffer.speech_started": {
      let s = state;
      const live = [s.response.activeId, s.response.audioId].filter(
        (id): id is string => id !== null,
      );
      if (live.length > 0) {
        // Barge-in. The server cancels, clears the audio and truncates it
        // itself (reference section 2); we only record what happened.
        s = interrupt(s, live);
        s = { ...s, response: { activeId: null, audioId: null } };
      }
      return setActivity(s, "userSpeaking");
    }
    case "input_audio_buffer.speech_stopped":
      return state.activity === "userSpeaking"
        ? setActivity(state, "thinking")
        : state;
    case "input_audio_buffer.committed": {
      // Announces the user's item and where it sits, before its text exists.
      const s = ensure(state, event.item_id, {
        role: "user",
        source: "voice",
        status: "transcribing",
      });
      return applyPrev(s, event.item_id, event.previous_item_id, "added");
    }

    case "conversation.item.added":
      return onItemEvent(state, "added", event.item, event.previous_item_id);
    case "conversation.item.done":
      return onItemEvent(state, "done", event.item, event.previous_item_id);
    case "conversation.item.truncated": {
      const it = state.items[event.item_id];
      return it && it.role === "assistant" && it.status !== "interrupted"
        ? patch(state, it.id, { status: "interrupted" })
        : state;
    }

    case "conversation.item.input_audio_transcription.delta": {
      const s = ensure(state, event.item_id, {
        role: "user",
        source: "voice",
        status: "transcribing",
      });
      const it = s.items[event.item_id];
      return it && it.role === "user" && it.status === "transcribing"
        ? patch(s, it.id, { text: it.text + event.delta })
        : s;
    }
    case "conversation.item.input_audio_transcription.completed": {
      let s = ensure(state, event.item_id, {
        role: "user",
        source: "voice",
        status: "transcribing",
      });
      s = { ...s, usage: addTranscriptionUsage(s.usage, event.usage) };
      const it = s.items[event.item_id];
      if (!it || it.role !== "user") return s;
      const text = event.transcript.trim();
      // Silence or noise comes back empty: nothing useful to show.
      return text === ""
        ? patch(s, it.id, { status: "transcriptionFailed" })
        : patch(s, it.id, { text, status: "done" });
    }
    case "conversation.item.input_audio_transcription.failed": {
      const s = ensure(state, event.item_id, {
        role: "user",
        source: "voice",
        status: "transcribing",
      });
      const it = s.items[event.item_id];
      return it && it.role === "user" && it.status === "transcribing"
        ? patch(s, it.id, { status: "transcriptionFailed" })
        : s;
    }

    case "response.created": {
      const s = {
        ...state,
        response: { ...state.response, activeId: event.response.id },
      };
      return s.activity === "listening" ? setActivity(s, "thinking") : s;
    }
    case "response.done":
      return onResponseDone(state, event.response);

    case "response.output_audio_transcript.delta":
      return onAnswerDelta(
        state,
        event.response_id,
        event.item_id,
        event.delta,
        "voice",
      );
    case "response.output_audio_transcript.done":
      return onAnswerDone(
        state,
        event.response_id,
        event.item_id,
        event.transcript,
        "voice",
      );
    case "response.output_text.delta":
      return onAnswerDelta(
        state,
        event.response_id,
        event.item_id,
        event.delta,
        "text",
      );
    case "response.output_text.done":
      return onAnswerDone(
        state,
        event.response_id,
        event.item_id,
        event.text,
        "text",
      );

    case "output_audio_buffer.started":
      // Audio for a response the user already talked over is being cleared.
      if (state.activity === "userSpeaking") return state;
      return setActivity(
        {
          ...state,
          response: { ...state.response, audioId: event.response_id },
        },
        "assistantSpeaking",
      );
    case "output_audio_buffer.stopped": {
      if (state.response.audioId !== event.response_id) return state;
      return settleActivity({
        ...state,
        response: { ...state.response, audioId: null },
      });
    }
    case "output_audio_buffer.cleared": {
      let s = interrupt(state, [event.response_id]);
      if (s.response.audioId === event.response_id) {
        s = settleActivity({
          ...s,
          response: { ...s.response, audioId: null },
        });
      }
      return s;
    }

    case "error": {
      const { code, type, event_id: eventId } = event.error;
      if (isBillingCode(code) || isBillingCode(type)) {
        return fail(state, "budget_exhausted");
      }
      const entry = eventId ? state.pending[eventId] : undefined;
      if (eventId && entry) {
        let s = omitPending(state, eventId);
        switch (entry.kind) {
          case "benign":
            // e.g. response.cancel with nothing in flight: a race we caused.
            return s;
          case "text":
            s = patch(s, entry.itemId, { status: "sendFailed" });
            break;
          case "response":
            break;
          default: {
            const unreachable: never = entry;
            void unreachable;
          }
        }
        s = {
          ...s,
          notice: { kind: "error", code: code ?? type ?? "unknown" },
        };
        return settleActivity(s);
      }
      return {
        ...state,
        notice: { kind: "error", code: code ?? type ?? "unknown" },
      };
    }

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

// --------------------------------------------------------------- reducer

export function reducer(state: RealtimeState, action: Action): RealtimeState {
  switch (action.type) {
    case "reset":
      return initialState;
    case "server":
      return onServerEvent(state, action.event);
    case "diagnostic": {
      const d = state.diagnostics;
      if (action.kind === "malformed") {
        return { ...state, diagnostics: { ...d, malformed: d.malformed + 1 } };
      }
      const type = action.eventType ?? "(no type)";
      const known = type in d.byType;
      const byType =
        known || Object.keys(d.byType).length < MAX_UNKNOWN_TYPES
          ? { ...d.byType, [type]: (d.byType[type] ?? 0) + 1 }
          : d.byType;
      return {
        ...state,
        diagnostics: { ...d, unknown: d.unknown + 1, byType },
      };
    }
    case "connection":
      return applyConnection(state, action.connection);
    case "mode":
      return { ...state, mode: action.mode, micIssue: action.micIssue };
    case "muted":
      return state.muted === action.muted
        ? state
        : { ...state, muted: action.muted };
    case "local-text": {
      let s = ensure(state, action.id, {
        role: "user",
        source: "text",
        status: "sending",
        text: action.text,
      });
      s = addPending(s, {
        [action.createEventId]: { kind: "text", itemId: action.id },
        [action.responseEventId]: { kind: "response" },
      });
      return s.activity === "listening" ? setActivity(s, "thinking") : s;
    }
    case "local-text-failed": {
      const it = state.items[action.id];
      if (!it || it.status !== "sending") return state;
      return settleActivity(
        dropPendingFor(
          patch(state, action.id, { status: "sendFailed" }),
          action.id,
        ),
      );
    }
    case "local-text-discard": {
      const it = state.items[action.id];
      if (!it || it.status !== "sendFailed") return state;
      const { [action.id]: _gone, ...items } = state.items;
      void _gone;
      return { ...state, items, order: visibleOrder(items) };
    }
    case "local-stop": {
      const live = [state.response.activeId, state.response.audioId].filter(
        (id): id is string => id !== null,
      );
      let s = interrupt(state, live);
      s = { ...s, response: { activeId: null, audioId: null } };
      return s.activity === "thinking" || s.activity === "assistantSpeaking"
        ? setActivity(s, "listening")
        : s;
    }
    case "benign":
      return addPending(state, { [action.eventId]: { kind: "benign" } });
    case "notice":
      return { ...state, notice: action.notice };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
