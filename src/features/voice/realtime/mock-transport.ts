import type { ClientEvent } from "./client-events";
import { parseJsonl, type RecordedEntry } from "./recorder";
import {
  TransportError,
  type ConnectOptions,
  type RealtimeTransport,
  type TransportErrorKind,
  type TransportState,
} from "./transport";
import { ev, type Json } from "./wire-events";

// A scripted stand-in for OpenAI. It plays timed server events and answers
// the client events it receives (text turns, cancel, clear), so tests and
// Playwright can drive the whole UI without a network. Selected by the
// test-only flag in transport-factory.ts, never in a production session.

export interface MockStep {
  /** Milliseconds after the session is created. */
  at: number;
  event: Json | string;
}

export interface MockScript {
  /** Delay before session.created. Default 150. */
  connectDelayMs?: number;
  /** Reject connect() with this kind instead of connecting. */
  failWith?: TransportErrorKind;
  /** Timed events, e.g. a user speaking or a scripted barge-in. */
  steps: MockStep[];
  /** Reply for typed messages. Default: a short fixed sentence. */
  textAnswer?: string;
  /** Whether replies to response.create stream as audio (voice) or text. */
  replyWith?: "text" | "audio";
  /** Milliseconds between words of a reply to a typed message. Default 60. */
  wordMs?: number;
}

export interface MockOptions {
  /** Divides every delay; 1 = real time. Tests can speed scenarios up. */
  speed?: number;
}

const DEFAULT_ANSWER = "This document is a short annual report.";
const DEFAULT_WORD_MS = 60;

// Rough usage block so the cost overlay has something to price.
export const MOCK_USAGE = {
  total_tokens: 640,
  input_tokens: 500,
  output_tokens: 140,
  input_token_details: {
    text_tokens: 480,
    audio_tokens: 20,
    image_tokens: 0,
    cached_tokens: 0,
    cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
  },
  output_token_details: { text_tokens: 20, audio_tokens: 120 },
};

// A typed reply has no audio output.
const MOCK_TEXT_USAGE = {
  ...MOCK_USAGE,
  total_tokens: 520,
  output_tokens: 20,
  input_token_details: {
    ...MOCK_USAGE.input_token_details,
    audio_tokens: 0,
    text_tokens: 500,
  },
  output_token_details: { text_tokens: 20, audio_tokens: 0 },
};

export class MockTransport implements RealtimeTransport {
  /** Every client event received, in order. Tests assert on this. */
  readonly sent: ClientEvent[] = [];
  /** How connect() was called, to check mic handling. */
  lastConnect: ConnectOptions | null = null;
  closeCount = 0;

  private state: TransportState = "idle";
  private closed = false;
  private used = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private responseTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastItemId: string | null = null;
  private inFlight: {
    responseId: string;
    itemId: string;
    audio: boolean;
  } | null = null;
  private counter = 0;
  private rejectConnect: ((e: TransportError) => void) | null = null;

  private readonly eventListeners = new Set<(raw: string) => void>();
  private readonly stateListeners = new Set<(s: TransportState) => void>();

  constructor(
    private readonly script: MockScript,
    private readonly options: MockOptions = {},
  ) {}

  onEvent(listener: (raw: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onStateChange(listener: (s: TransportState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onRemoteStream(): () => void {
    return () => {};
  }

  connect(options: ConnectOptions): Promise<void> {
    if (this.used || this.closed) {
      return Promise.reject(new TransportError("aborted"));
    }
    this.used = true;
    this.lastConnect = options;
    this.setState("connecting");
    return new Promise<void>((resolve, reject) => {
      this.rejectConnect = reject;
      this.later(this.script.connectDelayMs ?? 150, () => {
        this.rejectConnect = null;
        if (this.script.failWith) {
          this.setState("failed");
          reject(new TransportError(this.script.failWith));
          return;
        }
        this.deliver(ev.sessionCreated());
        this.setState("connected");
        resolve();
        for (const step of this.script.steps) {
          this.later(step.at, () => this.deliver(step.event));
        }
      });
    });
  }

  send(event: ClientEvent): boolean {
    if (this.state !== "connected") return false;
    this.sent.push(event);
    this.react(event);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCount += 1;
    this.rejectConnect?.(new TransportError("aborted"));
    this.rejectConnect = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.responseTimers.clear();
    this.setState("closed");
    this.eventListeners.clear();
    this.stateListeners.clear();
  }

  /** Test hook: push a server event now. */
  push(event: Json | string): void {
    this.deliver(event);
  }

  /** Test hook: pretend the media path changed. */
  emitState(state: TransportState): void {
    this.setState(state);
  }

  // ----------------------------------------------------------- the "server"

  private react(event: ClientEvent): void {
    switch (event.type) {
      case "conversation.item.create": {
        const text = event.item.content[0]?.text ?? "";
        const prev = this.lastItemId;
        this.later(20, () =>
          this.deliver(ev.userTextAdded(event.item.id, text, prev)),
        );
        // Claim the slot now so a quick follow-up links to this item.
        this.lastItemId = event.item.id;
        return;
      }
      case "response.create": {
        const audio =
          event.response === undefined && this.script.replyWith === "audio";
        this.startAnswer(this.script.textAnswer ?? DEFAULT_ANSWER, audio);
        return;
      }
      case "response.cancel": {
        const live = this.inFlight;
        if (!live) {
          // The real server answers a cancel with nothing in flight this way.
          this.later(10, () =>
            this.deliver(
              ev.error("response_cancel_not_active", event.event_id),
            ),
          );
          return;
        }
        this.cancelResponse(live, "client_cancelled");
        return;
      }
      case "output_audio_buffer.clear": {
        const live = this.inFlight;
        if (live?.audio) {
          this.later(10, () => this.deliver(ev.audioCleared(live.responseId)));
        }
        return;
      }
      default: {
        const unreachable: never = event;
        void unreachable;
      }
    }
  }

  private startAnswer(text: string, audio: boolean): void {
    this.counter += 1;
    const responseId = `resp_mock_${this.counter}`;
    const itemId = `item_mock_a${this.counter}`;
    const prev = this.lastItemId;
    this.lastItemId = itemId;
    this.inFlight = { responseId, itemId, audio };

    const words = text.split(/(?<=\s)/);
    let at = 20;
    const at_ = (ms: number, event: Json) => {
      const t = this.later(ms, () => this.deliver(event), this.responseTimers);
      return t;
    };
    at_(at, ev.responseCreated(responseId));
    at_((at += 20), ev.assistantAdded(itemId, prev));
    if (audio) at_((at += 40), ev.audioStarted(responseId));
    for (const w of words) {
      at += this.script.wordMs ?? DEFAULT_WORD_MS;
      at_(
        at,
        audio
          ? ev.audioDelta(responseId, itemId, w)
          : ev.textDelta(responseId, itemId, w),
      );
    }
    at += 20;
    at_(
      at,
      audio
        ? ev.audioTranscriptDone(responseId, itemId, text)
        : ev.textDone(responseId, itemId, text),
    );
    at_(at, ev.assistantDone(itemId, prev, text));
    at_(
      (at += 10),
      ev.responseDone(responseId, {
        outputIds: [itemId],
        usage: audio ? MOCK_USAGE : MOCK_TEXT_USAGE,
      }),
    );
    this.later(
      at,
      () => {
        if (this.inFlight?.responseId === responseId) this.inFlight = null;
      },
      this.responseTimers,
    );
    if (audio) at_((at += 300), ev.audioStopped(responseId));
  }

  private cancelResponse(
    live: { responseId: string; itemId: string; audio: boolean },
    reason: string,
  ): void {
    for (const t of this.responseTimers) {
      clearTimeout(t);
      this.timers.delete(t);
    }
    this.responseTimers.clear();
    this.inFlight = null;
    this.later(10, () =>
      this.deliver(
        ev.responseDone(live.responseId, {
          status: "cancelled",
          reason,
          outputIds: [live.itemId],
        }),
      ),
    );
  }

  // --------------------------------------------------------------- plumbing

  private deliver(event: Json | string): void {
    if (this.closed) return;
    const raw = typeof event === "string" ? event : JSON.stringify(event);
    if (
      typeof event !== "string" &&
      event["type"] === "conversation.item.added"
    ) {
      const item = event["item"];
      if (typeof item === "object" && item !== null && "id" in item) {
        if (typeof item.id === "string") this.lastItemId = item.id;
      }
    }
    for (const l of this.eventListeners) l(raw);
  }

  private later(
    ms: number,
    fn: () => void,
    also?: Set<ReturnType<typeof setTimeout>>,
  ): ReturnType<typeof setTimeout> {
    const speed = this.options.speed ?? 1;
    const t = setTimeout(() => {
      this.timers.delete(t);
      also?.delete(t);
      fn();
    }, ms / speed);
    this.timers.add(t);
    also?.add(t);
    return t;
  }

  private setState(next: TransportState): void {
    if (this.state === next) return;
    this.state = next;
    for (const l of this.stateListeners) l(next);
  }
}

/**
 * Turns a recorded session (see recorder.ts) into a script: every server
 * event replays at its original offset from session.created. Our own
 * session.created is emitted by connect(), so recorded ones are dropped.
 */
export function scriptFromRecording(
  source: string | RecordedEntry[],
  extra: Partial<MockScript> = {},
): MockScript {
  const entries = typeof source === "string" ? parseJsonl(source) : source;
  const incoming = entries.filter((e) => e.dir === "in");
  const created = incoming.find(
    (e) => isRecord(e.data) && e.data["type"] === "session.created",
  );
  const origin = created?.t ?? incoming[0]?.t ?? 0;
  const steps: MockStep[] = [];
  for (const e of incoming) {
    if (!isRecord(e.data)) continue;
    const type = e.data["type"];
    if (type === "session.created" || type === "session.updated") continue;
    steps.push({ at: Math.max(0, e.t - origin), event: e.data });
  }
  return { ...extra, steps };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
