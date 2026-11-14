import { parseServerEvent } from "@/features/voice/realtime/events";
import { reducer, type Action } from "@/features/voice/realtime/reducer";
import {
  initialState,
  type RealtimeState,
  type TranscriptItem,
} from "@/features/voice/realtime/state";

export { ev, type Json } from "@/features/voice/realtime/wire-events";
import type { Json } from "@/features/voice/realtime/wire-events";

/** Feeds one raw event through parse + reduce, as the controller does. */
export function feed(state: RealtimeState, raw: Json | string): RealtimeState {
  const parsed = parseServerEvent(
    typeof raw === "string" ? raw : JSON.stringify(raw),
  );
  switch (parsed.kind) {
    case "event":
      return reducer(state, { type: "server", event: parsed.event });
    case "unknown":
      return reducer(state, {
        type: "diagnostic",
        kind: "unknown",
        eventType: parsed.type,
      });
    case "malformed":
      return reducer(state, {
        type: "diagnostic",
        kind: "malformed",
        eventType: parsed.type,
      });
    case "ignored":
      return state;
  }
}

export function play(
  events: Array<Json | string>,
  from: RealtimeState,
): RealtimeState {
  return events.reduce<RealtimeState>((s, e) => feed(s, e), from);
}

export function dispatch(
  state: RealtimeState,
  ...actions: Action[]
): RealtimeState {
  return actions.reduce(reducer, state);
}

/** A voice session that has connected and received session.created. */
export function connected(mode: "voice" | "text" = "voice"): RealtimeState {
  return dispatch(
    initialState,
    { type: "mode", mode, micIssue: null },
    {
      type: "connection",
      connection: { status: "connecting", phase: "negotiating" },
    },
    { type: "server", event: { type: "session.created" } },
    { type: "connection", connection: { status: "connected" } },
  );
}

export function visible(state: RealtimeState): TranscriptItem[] {
  return state.order.map((id) => {
    const it = state.items[id];
    if (!it) throw new Error(`order lists unknown item ${id}`);
    return it;
  });
}

export function transcript(
  state: RealtimeState,
): Array<[string, string, string]> {
  return visible(state).map((it) => [it.role, it.status, it.text]);
}

/** Replays a recorded session's incoming events (see recorder.ts) through parse + reduce. */
export function replay(
  entries: Array<{ dir: string; data: unknown }>,
  from: RealtimeState = connected(),
): RealtimeState {
  let s = from;
  for (const e of entries) {
    if (e.dir !== "in") continue;
    // session.created is what connected() already applied.
    if (
      typeof e.data === "object" &&
      e.data !== null &&
      "type" in e.data &&
      e.data.type === "session.created"
    ) {
      continue;
    }
    s = feed(s, JSON.stringify(e.data));
  }
  return s;
}
