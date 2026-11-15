import { sleep } from "@/lib/net/timeout";
import type { SessionResponse } from "@/lib/wire/session";
import {
  cancelResponse,
  clearOutputAudio,
  createResponse,
  createTextItem,
  newEventId,
  newItemId,
  type ClientEvent,
} from "./client-events";
import { parseServerEvent } from "./events";
import type { FailureCode, MicFailure } from "./failure";
import type { LevelKind, LevelListener, LevelMeter } from "./levels";
import { MintError, type HistoryTurn } from "./mint";
import { stopStream, type MicPermission, type MicResult } from "./mic";
import type { EventRecorder } from "./recorder";
import { reducer, type Action } from "./reducer";
import {
  EMPTY_LEDGER,
  RECONNECT_GRACE_MS,
  reconnectStep,
  type LinkDeath,
  type ReconnectEffect,
  type ReconnectInput,
  type ReconnectLedger,
  type Reconnecting,
} from "./reconnect";
import {
  initialState,
  type ConnectionState,
  type Mode,
  type RealtimeState,
} from "./state";
import {
  TransportError,
  type RealtimeTransport,
  type TransportErrorKind,
  type TransportState,
} from "./transport";

// The session controller: the one place where the pure core (events,
// reducer) meets the outside world (mic, mint, transport, audio, timers).
// Framework-agnostic: the React hook is a thin wrapper around this class.
//
// Rules it keeps:
//  - Everything that must happen inside the user's tap (mic prompt, audio
//    element, AudioContext) happens synchronously at the top of start().
//  - Every await is followed by a "still the same run?" check, so End or
//    unmount at any point releases whatever that step had just acquired.
//  - One cleanup() releases everything and is safe to call twice.
//  - A chat mints one client secret. Adding a microphone to a text chat goes
//    through the connection that already exists (enableMic); nothing touches
//    the network until getUserMedia has actually returned a stream.

export const IDLE_MS = 120_000;
export const HIDDEN_MS = 60_000;
export { RECONNECT_GRACE_MS };
export const CAP_WARNING_MS = 60_000;
/** Taps on "Try microphone again" closer together than this are one tap. */
export const MIC_RETRY_MIN_MS = 1_000;
/** A mic that ends again sooner than this after being re-acquired is not coming back. */
export const MIC_REACQUIRE_MIN_MS = 3_000;
/** How long a first start waits for the connection before giving up. */
export const FIRST_START_OFFLINE_WAIT_MS = 60_000;
/**
 * Error codes that mean the server ended the session. UNVERIFIED: OpenAI's
 * docs only state the 60-minute maximum and name no code (reference doc §5).
 */
export const SESSION_EXPIRED_CODES: ReadonlySet<string> = new Set([
  "session_expired",
]);

export interface SessionDeps {
  mint(
    documentId: string,
    signal: AbortSignal,
    history?: readonly HistoryTurn[],
  ): Promise<SessionResponse>;
  /** Called synchronously from start(), inside the user's tap. */
  requestMic(): Promise<MicResult>;
  /** What asking for the mic would do, without asking. Never rejects. */
  queryMicPermission(): Promise<MicPermission>;
  createTransport(ctx: {
    audioElement: HTMLAudioElement | null;
  }): RealtimeTransport | Promise<RealtimeTransport>;
  createAudioElement(): HTMLAudioElement | null;
  removeAudioElement(el: HTMLAudioElement | null): void;
  createAudioContext(): AudioContext | null;
  createLevelMeter(ctx: AudioContext | null): LevelMeter;
  /** null unless the dev tools are on. Called once per start(). */
  createRecorder(): EventRecorder | null;
  now(): number;
  /** The device has no link, or the last request got no answer. */
  isOffline(): boolean;
  /** Resolves when the connection is back; rejects with an AbortError on abort. */
  waitForConnection(signal: AbortSignal): Promise<void>;
  /** Log unknown and malformed events to the console. */
  isDebug(): boolean;
  visibility: {
    isHidden(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

interface Resources {
  audioElement: HTMLAudioElement | null;
  audioContext: AudioContext | null;
  meter: LevelMeter | null;
  mic: MediaStream | null;
  micCleanup: (() => void) | null;
  transport: RealtimeTransport | null;
  abort: AbortController | null;
}

type TimerName = "cap" | "capWarning" | "idle" | "hidden" | "reconnect";

function emptyResources(): Resources {
  return {
    audioElement: null,
    audioContext: null,
    meter: null,
    mic: null,
    micCleanup: null,
    transport: null,
    abort: null,
  };
}

export function failureForTransportError(err: unknown): FailureCode | null {
  if (!(err instanceof TransportError)) return "session_connect_failed";
  switch (err.kind) {
    case "aborted":
      return null;
    case "busy":
      return "session_upstream_busy";
    case "budget":
      return "budget_exhausted";
    case "network":
      return "session_network_failed";
    case "timeout":
    case "rejected":
    case "unsupported":
      return "session_connect_failed";
    default: {
      const unreachable: never = err.kind;
      return unreachable;
    }
  }
}

function kindOf(err: unknown): TransportErrorKind {
  return err instanceof TransportError ? err.kind : "rejected";
}

export class VoiceSession {
  /** Model the server minted the session for; null before the first mint. */
  model: string | null = null;
  maxSessionSeconds: number | null = null;

  /** The dev-only event log of the current (or last) chat. */
  recorder: EventRecorder | null = null;

  private state: RealtimeState = initialState;
  private readonly listeners = new Set<() => void>();
  private runId = 0;
  private res: Resources = emptyResources();
  private readonly timers: Partial<
    Record<TimerName, ReturnType<typeof setTimeout>>
  > = {};
  private offVisibility: (() => void) | null = null;
  // Wall-clock bookkeeping. Browsers freeze timers in background tabs (iOS
  // Safari most of all), so a timer alone cannot be trusted to have fired by
  // the time the user comes back; these let us judge by the clock instead.
  private hiddenSince: number | null = null;
  private capDeadline: number | null = null;
  private lastActivityAt = 0;
  private lastMicRetryAt = Number.NEGATIVE_INFINITY;
  private lastMicReacquireAt = Number.NEGATIVE_INFINITY;
  /** The reconnect machine's state; null while the chat is live or not started. */
  private rc: Reconnecting | null = null;
  /** What the machine remembers across outages: mints spent, when the last rebuild came up. */
  private ledger: ReconnectLedger = EMPTY_LEDGER;
  /** A secret minted for a reconnect, between the mint and the connect. */
  private pendingSecret: string | null = null;
  /** The reconnect built a new session (not just a healed link). */
  private newSession = false;
  /**
   * A new mic was taken while the link was being rebuilt, and the connection
   * that comes up was not built with it: swap it in (replaceTrack) once up.
   */
  private micNeedsSwap = false;
  private readonly levelListeners: Record<LevelKind, Set<LevelListener>> = {
    mic: new Set(),
    remote: new Set(),
  };
  private readonly levelOffs: Record<LevelKind, (() => void) | null> = {
    mic: null,
    remote: null,
  };

  constructor(
    private readonly documentId: string,
    private readonly deps: SessionDeps,
  ) {}

  // -------------------------------------------------------------- store

  readonly getState = (): RealtimeState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Level meter feed. Survives restarts: subscribe once, use for every session. */
  readonly subscribeLevel = (
    kind: LevelKind,
    listener: LevelListener,
  ): (() => void) => {
    this.levelListeners[kind].add(listener);
    this.bindLevels();
    return () => {
      this.levelListeners[kind].delete(listener);
      this.bindLevels();
    };
  };

  // ------------------------------------------------------------ actions

  /**
   * Starts a chat. Call it straight from the tap handler: the mic prompt and
   * the audio unlock must happen in the same gesture.
   */
  start(mode: Mode): void {
    const status = this.state.connection.status;
    if (status !== "idle" && status !== "ended" && status !== "failed") return;
    this.begin(mode, null);
  }

  /**
   * Turns a text chat into a voice chat, from a tap on "Try microphone again"
   * or the mic button. The order is the point:
   *  1. Ask the browser whether the mic is blocked. If it is, say so and stop.
   *  2. getUserMedia. If it fails, say why and stop.
   *  3. Only with a stream in hand, attach it to the connection that already
   *     exists. No new session, no new client secret.
   * Steps 1 and 2 never touch the network, so tapping a button that cannot
   * work costs nothing. (It used to restart the chat first, minting a secret
   * per tap, and a few taps locked a real phone out of the per-IP limit.)
   */
  enableMic(): void {
    const s = this.state;
    if (s.connection.status !== "connected" || s.mode !== "text") return;
    if (s.micRetry === "working") return;
    const now = this.deps.now();
    if (now - this.lastMicRetryAt < MIC_RETRY_MIN_MS) return;
    this.lastMicRetryAt = now;

    // Still inside the tap: a text chat may never have unlocked audio output.
    void this.res.audioContext?.resume().catch(() => {});
    void this.res.audioElement?.play?.()?.catch(() => {});

    const run = this.runId;
    this.recorder?.recordMeta({ event: "mic_retry" });
    this.dispatch({ type: "mic-retry", status: "working" });
    this.upgradeToVoice(run)
      // Nothing in there should throw; if it does, the chat stays a text chat.
      .catch(() => {})
      .finally(() => {
        if (this.live(run))
          this.dispatch({ type: "mic-retry", status: "idle" });
      });
  }

  private begin(
    mode: Mode,
    micInHand: MediaStream | null,
    carry: readonly HistoryTurn[] | null = null,
    /** The new session continues a chat whose connection was lost. */
    reconnected = false,
  ): void {
    const run = ++this.runId;
    const abort = new AbortController();
    this.res = {
      ...emptyResources(),
      abort,
      audioElement: this.deps.createAudioElement(),
      audioContext: this.deps.createAudioContext(),
    };
    this.res.meter = this.deps.createLevelMeter(this.res.audioContext);
    this.bindLevels();

    this.recorder = this.deps.createRecorder();
    this.recorder?.recordMeta({ event: "start", mode });
    // A replacement session keeps the transcript on screen; a new chat starts clean.
    this.dispatch({ type: carry ? "restart" : "reset" });
    this.dispatch({ type: "mode", mode, micIssue: null });

    let micRequest: Promise<MicResult> | null = null;
    if (mode === "voice") {
      this.dispatch({
        type: "connection",
        connection: { status: "requestingMic" },
      });
      micRequest = micInHand
        ? Promise.resolve({ ok: true, stream: micInHand })
        : this.deps.requestMic();
    } else {
      this.dispatch({
        type: "connection",
        connection: { status: "connecting", phase: "minting" },
      });
    }
    this.run(run, abort.signal, micRequest, carry ?? [], reconnected).catch(
      () => {
        // An unexpected throw must not leave the chat stuck on "connecting".
        if (this.live(run)) this.fail("session_connect_failed");
      },
    );
  }

  /** Ends the chat on the user's request. Safe at any point, any number of times. */
  end(): void {
    this.finish({ status: "ended", reason: "user" });
  }

  /**
   * "Reconnect" on the Connection lost card: one new session, the transcript
   * kept on screen and sent along as history. Call it from the tap, so the mic
   * (already allowed) can be opened again.
   */
  reconnect(): void {
    const s = this.state;
    if (s.connection.status !== "failed") return;
    this.begin(s.mode, null, this.visibleTurns(), true);
  }

  /** "Switch to text" on the Connection lost card: same, without a microphone. */
  switchToText(): void {
    if (this.state.connection.status !== "failed") return;
    this.begin("text", null, this.visibleTurns(), true);
  }

  /** Mute is a flag on the mic track: no renegotiation, no state change in the transport. */
  setMuted(muted: boolean): void {
    const mic = this.res.mic;
    if (!mic) return;
    for (const track of mic.getAudioTracks()) track.enabled = !muted;
    this.dispatch({ type: "muted", muted });
  }

  /** Stop the answer: response.cancel, then clear the audio that is already queued. */
  stopAnswer(): void {
    const s = this.state;
    if (s.connection.status !== "connected") return;
    const busy =
      s.response.activeId !== null ||
      s.response.audioId !== null ||
      s.activity === "thinking" ||
      s.activity === "assistantSpeaking";
    if (!busy) return;
    this.cancelAndClear();
    this.dispatch({ type: "local-stop" });
  }

  /** Sends a typed message. The bubble shows at once and is reconciled by item id. */
  sendText(raw: string): void {
    const text = raw.trim();
    if (text === "" || this.state.connection.status !== "connected") return;

    // A new question while one is being answered replaces that answer.
    const s = this.state;
    if (s.response.activeId !== null || s.response.audioId !== null) {
      this.cancelAndClear();
      this.dispatch({ type: "local-stop" });
    }

    const id = newItemId();
    const createEventId = newEventId();
    const responseEventId = newEventId();
    this.dispatch({
      type: "local-text",
      id,
      text,
      createEventId,
      responseEventId,
    });

    const created = this.send(createTextItem(id, text, createEventId));
    // In a voice chat a typed question is answered out loud, like any other.
    const asked =
      created &&
      this.send(createResponse(responseEventId, this.state.mode === "text"));
    if (!asked) this.dispatch({ type: "local-text-failed", id });
  }

  /** Re-sends a message that failed ("Not sent. Tap to retry."). */
  retryText(itemId: string): void {
    const item = this.state.items[itemId];
    if (!item || item.status !== "sendFailed") return;
    this.dispatch({ type: "local-text-discard", id: itemId });
    this.sendText(item.text);
  }

  /** Called when the owner goes away (unmount, new document). Same as End. */
  detach(): void {
    this.end();
    // A chat that never got going still holds the tap-time resources.
    this.cleanup();
  }

  // ----------------------------------------------------------- the run

  private live(run: number): boolean {
    return this.runId === run;
  }

  private async run(
    run: number,
    signal: AbortSignal,
    micRequest: Promise<MicResult> | null,
    history: readonly HistoryTurn[],
    reconnected: boolean,
  ): Promise<void> {
    let mic: MediaStream | null = null;
    if (micRequest) {
      const result = await micRequest;
      if (!this.live(run)) {
        if (result.ok) stopStream(result.stream);
        return;
      }
      if (result.ok) {
        mic = result.stream;
        this.adoptMic(run, mic);
      } else {
        // No mic is not the end of the chat: carry on in text mode.
        this.dispatch({ type: "mode", mode: "text", micIssue: result.reason });
        this.recorder?.recordMeta({
          event: "mic_failed",
          reason: result.reason,
        });
      }
    }

    this.dispatch({
      type: "connection",
      connection: { status: "connecting", phase: "minting" },
    });
    let minted: SessionResponse | null = null;
    // A mint nobody answered created nothing, so one more try after the
    // connection is back still means one secret for the chat.
    for (let attempt = 0; minted === null; attempt++) {
      try {
        minted = await this.deps.mint(this.documentId, signal, history);
      } catch (err) {
        if (!this.live(run)) return;
        if (
          attempt === 0 &&
          err instanceof MintError &&
          err.code === "session_network_failed"
        ) {
          this.dispatch({
            type: "connection",
            connection: { status: "connecting", phase: "waitingNetwork" },
          });
          const back = await this.waitForNetwork(
            signal,
            FIRST_START_OFFLINE_WAIT_MS,
          );
          if (!this.live(run)) return;
          if (!back) {
            this.fail("session_network_failed");
            return;
          }
          this.dispatch({
            type: "connection",
            connection: { status: "connecting", phase: "minting" },
          });
          continue;
        }
        if (err instanceof MintError)
          this.fail(err.code, err.retryAfterSeconds);
        else this.fail("session_connect_failed");
        return;
      }
    }
    if (!this.live(run)) return;
    this.model = minted.model;
    this.maxSessionSeconds = minted.maxSessionSeconds;
    this.recorder?.recordMeta({ event: "minted", model: minted.model });

    this.dispatch({
      type: "connection",
      connection: { status: "connecting", phase: "negotiating" },
    });
    let transport: RealtimeTransport;
    try {
      transport = await this.deps.createTransport({
        audioElement: this.res.audioElement,
      });
    } catch (err) {
      if (!this.live(run)) return;
      this.fail(failureForTransportError(err) ?? "session_connect_failed");
      return;
    }
    if (!this.live(run)) {
      transport.close();
      return;
    }
    this.attachTransport(transport);

    try {
      await transport.connect({
        clientSecret: minted.clientSecret,
        // The mic as it is now: it may have been replaced while minting.
        micStream: this.state.mode === "voice" ? this.res.mic : null,
      });
    } catch (err) {
      if (!this.live(run)) return;
      this.fail(failureForTransportError(err) ?? "session_connect_failed");
      return;
    }
    if (!this.live(run)) return;

    this.dispatch({ type: "connection", connection: { status: "connected" } });
    if (reconnected) this.dispatch({ type: "reconnected" });
    this.startTimers(minted.maxSessionSeconds);
  }

  /** Hooks a transport up to the chat. Callbacks from a transport we have replaced are ignored. */
  private attachTransport(transport: RealtimeTransport): void {
    this.res.transport = transport;
    transport.onEvent((raw) => {
      if (this.res.transport === transport) this.onRaw(raw);
    });
    transport.onStateChange((s) => this.onTransportState(s, transport));
    transport.onRemoteStream((stream) => {
      if (this.res.transport === transport) {
        this.res.meter?.attach("remote", stream);
      }
    });
  }

  /** Waits for the connection, at most `maxMs`. false = gave up (or aborted). */
  private async waitForNetwork(
    signal: AbortSignal,
    maxMs: number,
  ): Promise<boolean> {
    const inner = new AbortController();
    const onAbort = () => inner.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const back = this.deps.waitForConnection(inner.signal).then(
      () => true,
      () => false,
    );
    const gaveUp = sleep(maxMs, inner.signal).then(
      () => false,
      () => false,
    );
    const ok = await Promise.race([back, gaveUp]);
    inner.abort();
    signal.removeEventListener("abort", onAbort);
    return ok;
  }

  // ---------------------------------------------------------------- mic

  /** Takes ownership of a mic stream: cleanup() stops it from here on. */
  private adoptMic(run: number, stream: MediaStream): void {
    // A voice chat whose mic died still holds the dead stream.
    this.res.micCleanup?.();
    stopStream(this.res.mic);
    this.res.mic = stream;
    this.res.meter?.attach("mic", stream);
    // The mic can disappear mid-chat (unplugged, revoked, taken by a call).
    const tracks = stream.getAudioTracks();
    const onEnded = () => this.onMicEnded(run);
    for (const t of tracks) t.addEventListener("ended", onEnded);
    this.res.micCleanup = () => {
      for (const t of tracks) t.removeEventListener("ended", onEnded);
    };
  }

  private async upgradeToVoice(run: number): Promise<void> {
    const permission = await this.deps.queryMicPermission();
    if (!this.live(run)) return;
    if (permission === "denied") {
      // getUserMedia would fail without a prompt; skip straight to the coach.
      this.micRetryFailed("denied");
      return;
    }

    const result = await this.deps.requestMic();
    if (!this.live(run)) {
      if (result.ok) stopStream(result.stream);
      return;
    }
    if (!result.ok) {
      this.micRetryFailed(result.reason);
      return;
    }

    const transport = this.res.transport;
    const stream = result.stream;
    this.adoptMic(run, stream);
    if (this.rc !== null) {
      // The link died while the prompt was open. Restarting here would abort
      // the reconnect and mint outside its attempt cap; the connection that
      // is being built takes the mic instead.
      this.deferMicToReconnect();
      this.recorder?.recordMeta({ event: "mic_upgraded" });
      this.dispatch({ type: "mode", mode: "voice", micIssue: null });
      return;
    }
    const upgraded = (await transport?.upgradeMic(stream)) ?? false;
    if (!this.live(run)) return;
    if (upgraded) {
      this.recorder?.recordMeta({ event: "mic_upgraded" });
      this.dispatch({ type: "mode", mode: "voice", micIssue: null });
      return;
    }
    this.restartWithMic(stream);
  }

  private micRetryFailed(reason: MicFailure): void {
    this.recorder?.recordMeta({ event: "mic_failed", reason });
    this.dispatch({ type: "mic-retry-failed", reason });
  }

  /**
   * The connection would not take the track. One new session with one new
   * secret, and only now that the mic is known to work: the stream we already
   * hold is carried over, so there is no second permission prompt and no
   * second getUserMedia. The transcript stays on screen, and the turns so far
   * go to the new session as history so the model has not forgotten them.
   */
  private restartWithMic(stream: MediaStream): void {
    const history = this.visibleTurns();
    // Out of cleanup's reach: the mic is the one thing worth keeping.
    this.res.micCleanup?.();
    this.res.micCleanup = null;
    this.res.mic = null;
    this.cleanup();
    // Not inside a tap any more, but a page that is capturing the mic may
    // start audio without one, so the new audio element still plays.
    this.begin("voice", stream, history);
    this.recorder?.recordMeta({ event: "mic_restart" });
  }

  /** The finished turns on screen, oldest first, as the mint wants them. */
  private visibleTurns(): HistoryTurn[] {
    const { order, items } = this.state;
    return order.flatMap((id) => {
      const item = items[id];
      if (!item || (item.status !== "done" && item.status !== "interrupted")) {
        return [];
      }
      return [{ role: item.role, text: item.text }];
    });
  }

  // ------------------------------------------------------------- events

  private onRaw(raw: string): void {
    this.recorder?.recordIn(raw);
    const parsed = parseServerEvent(raw);
    switch (parsed.kind) {
      case "event":
        this.dispatch({ type: "server", event: parsed.event });
        if (
          parsed.event.type === "error" &&
          SESSION_EXPIRED_CODES.has(parsed.event.error.code ?? "")
        ) {
          // The server ended the session: same road as a dead link.
          this.onLinkDead("session-expired");
        }
        return;
      case "ignored":
        return;
      case "unknown":
        if (this.deps.isDebug())
          console.debug("[realtime] unknown event", parsed.type);
        this.dispatch({
          type: "diagnostic",
          kind: "unknown",
          eventType: parsed.type,
        });
        return;
      case "malformed":
        if (this.deps.isDebug()) {
          console.debug(
            "[realtime] malformed event",
            parsed.type ?? "(no type)",
          );
        }
        this.dispatch({
          type: "diagnostic",
          kind: "malformed",
          eventType: parsed.type,
        });
        return;
      default: {
        const unreachable: never = parsed;
        void unreachable;
      }
    }
  }

  /**
   * The mic track ended (Bluetooth switch, an OS interruption, a call). Get
   * the mic again once and swap it onto the connection we already have with
   * replaceTrack: no renegotiation and no new client secret. Only if that
   * fails, or the mic keeps dying, does the chat carry on in text.
   */
  private onMicEnded(run: number): void {
    if (!this.live(run) || this.state.mode === "text") return;
    this.res.meter?.attach("mic", null);
    this.recorder?.recordMeta({ event: "mic_ended" });
    const now = this.deps.now();
    if (now - this.lastMicReacquireAt < MIC_REACQUIRE_MIN_MS) {
      this.micToText("unavailable");
      return;
    }
    this.lastMicReacquireAt = now;
    this.reacquireMic(run).catch(() => {
      if (this.live(run)) this.micToText("unavailable");
    });
  }

  private micToText(reason: MicFailure): void {
    this.dispatch({ type: "muted", muted: false });
    this.dispatch({ type: "mode", mode: "text", micIssue: reason });
  }

  private async reacquireMic(run: number): Promise<void> {
    const result = await this.deps.requestMic();
    if (!this.live(run)) {
      if (result.ok) stopStream(result.stream);
      return;
    }
    if (!result.ok) {
      this.recorder?.recordMeta({ event: "mic_failed", reason: result.reason });
      this.micToText(result.reason);
      return;
    }
    const stream = result.stream;
    this.adoptMic(run, stream);
    // A muted chat stays muted across the swap.
    if (this.state.muted) {
      for (const t of stream.getAudioTracks()) t.enabled = false;
    }
    const transport = this.res.transport;
    // Mid-reconnect there is no (healthy) connection to swap into right now.
    if (this.rc !== null) {
      this.deferMicToReconnect();
      this.recorder?.recordMeta({ event: "mic_reacquired" });
      return;
    }
    // Before the first connect: run() reads the mic as it is when it connects.
    if (!transport) {
      this.recorder?.recordMeta({ event: "mic_reacquired" });
      return;
    }
    await this.swapMicIn(run, transport);
  }

  /**
   * Puts this.res.mic on `transport` with replaceTrack (no renegotiation, no
   * new secret). If the connection will not take it, the chat carries on in
   * text and the stream is released.
   */
  private async swapMicIn(
    run: number,
    transport: RealtimeTransport,
  ): Promise<void> {
    const stream = this.res.mic;
    if (!stream) return;
    const swapped = await transport.upgradeMic(stream);
    if (!this.live(run)) return;
    if (swapped) {
      this.recorder?.recordMeta({ event: "mic_reacquired" });
      return;
    }
    stopStream(stream);
    this.res.mic = null;
    this.micToText("unavailable");
  }

  /**
   * A mic arrived while the link is being rebuilt. Early phases connect with
   * this.res.mic as it is by then. But during grace the old connection may
   * heal and keep its dead sender, and a connect that is already under way
   * was started with the old track: in both, swap it in once the link is up.
   */
  private deferMicToReconnect(): void {
    const phase = this.rc?.phase;
    if (phase === "grace" || phase === "connecting") this.micNeedsSwap = true;
  }

  private onTransportState(s: TransportState, from: RealtimeTransport): void {
    // A transport we have already replaced has nothing to say.
    if (this.res.transport !== from) return;
    const status = this.state.connection.status;
    switch (s) {
      case "disconnected":
        if (status === "connected") this.feed({ type: "link-lost" });
        return;
      case "connected":
        // Only a link that was waiting in grace can heal by itself.
        if (this.rc?.phase === "grace") this.feed({ type: "link-recovered" });
        return;
      case "failed":
        // While connecting, connect() reports the failure with its own kind.
        this.onLinkDead("failed");
        return;
      case "idle":
      case "connecting":
      case "closed":
        return;
      default: {
        const unreachable: never = s;
        void unreachable;
      }
    }
  }

  /** The link is gone for good (or the server hung up): get a new session. */
  private onLinkDead(cause: LinkDeath): void {
    const status = this.state.connection.status;
    const inGrace = this.rc?.phase === "grace";
    if (status === "connected" || (status === "reconnecting" && inGrace)) {
      this.feed({ type: "link-dead", cause });
    }
  }

  // ---------------------------------------------------------- reconnect

  /** Gives the machine one input and carries out what it asks for. */
  private feed(input: ReconnectInput): void {
    const step = reconnectStep(this.rc, input, {
      now: this.deps.now(),
      offline: this.deps.isOffline(),
      ledger: this.ledger,
    });
    this.rc = step.state;
    this.ledger = step.ledger;
    // The phase goes on screen first, so effects that end the chat win.
    if (step.state) {
      this.dispatch({ type: "connection", connection: step.state });
    }
    for (const effect of step.effects) this.runEffect(effect);
  }

  private runEffect(effect: ReconnectEffect): void {
    const run = this.runId;
    switch (effect.type) {
      case "start-timer":
        this.setTimer("reconnect", effect.ms, () =>
          this.feed({ type: "timer" }),
        );
        return;
      case "clear-timer":
        this.clearTimer("reconnect");
        return;
      case "close-transport": {
        // Only the link goes: the mic, audio element and meter are reused.
        const transport = this.res.transport;
        this.res.transport = null;
        transport?.close();
        this.res.meter?.attach("remote", null);
        return;
      }
      case "settle-items":
        this.dispatch({ type: "reconnect-settle" });
        return;
      case "wait-online": {
        const signal = this.res.abort?.signal;
        if (!signal) return;
        this.deps.waitForConnection(signal).then(
          () => {
            if (this.live(run)) this.feed({ type: "online" });
          },
          () => {},
        );
        return;
      }
      case "mint":
        void this.reconnectMint(run);
        return;
      case "connect":
        void this.reconnectConnect(run);
        return;
      case "recovered": {
        const swapMic = this.micNeedsSwap;
        this.micNeedsSwap = false;
        this.dispatch({
          type: "connection",
          connection: { status: "connected" },
        });
        if (this.newSession) {
          this.newSession = false;
          this.dispatch({ type: "reconnected" });
        }
        this.recorder?.recordMeta({ event: "reconnected" });
        this.armIdle();
        const transport = this.res.transport;
        if (swapMic && transport && this.state.mode === "voice") {
          void this.swapMicIn(run, transport);
        }
        return;
      }
      case "fail":
        // Out of a reconnect: Retry keeps the conversation (reconnect()).
        this.fail(effect.code, effect.retryAfterSeconds, true);
        return;
      default: {
        const unreachable: never = effect;
        void unreachable;
      }
    }
  }

  private async reconnectMint(run: number): Promise<void> {
    const signal = this.res.abort?.signal;
    if (!signal) return;
    let minted: SessionResponse;
    try {
      minted = await this.deps.mint(
        this.documentId,
        signal,
        this.visibleTurns(),
      );
    } catch (err) {
      if (!this.live(run)) return;
      if (err instanceof MintError) {
        this.feed({
          type: "mint-error",
          code: err.code,
          ...(err.retryAfterSeconds !== undefined && {
            retryAfterSeconds: err.retryAfterSeconds,
          }),
        });
      } else {
        this.feed({ type: "mint-error", code: "session_connect_failed" });
      }
      return;
    }
    if (!this.live(run)) return;
    // The cap and the model of this chat stay as they were.
    this.pendingSecret = minted.clientSecret;
    this.recorder?.recordMeta({ event: "reminted", model: minted.model });
    this.feed({ type: "mint-ok" });
  }

  private async reconnectConnect(run: number): Promise<void> {
    const secret = this.pendingSecret;
    this.pendingSecret = null;
    if (secret === null) return;
    let transport: RealtimeTransport;
    try {
      transport = await this.deps.createTransport({
        audioElement: this.res.audioElement,
      });
    } catch (err) {
      if (this.live(run))
        this.feed({ type: "connect-error", kind: kindOf(err) });
      return;
    }
    if (!this.live(run)) {
      transport.close();
      return;
    }
    this.attachTransport(transport);
    // This connect is built with the mic as it is right now.
    this.micNeedsSwap = false;
    try {
      await transport.connect({
        clientSecret: secret,
        micStream: this.state.mode === "voice" ? this.res.mic : null,
      });
    } catch (err) {
      if (!this.live(run)) return;
      if (this.res.transport === transport) this.res.transport = null;
      transport.close();
      this.feed({ type: "connect-error", kind: kindOf(err) });
      return;
    }
    if (!this.live(run)) return;
    this.newSession = true;
    this.feed({ type: "connect-ok" });
  }

  // ------------------------------------------------------------ sending

  private send(event: ClientEvent): boolean {
    const transport = this.res.transport;
    if (!transport) return false;
    this.recorder?.recordOut(event);
    return transport.send(event);
  }

  private cancelAndClear(): void {
    // Order matters on WebRTC: cancel first, then clear what is queued.
    const cancelId = newEventId();
    this.dispatch({ type: "benign", eventId: cancelId });
    this.send(cancelResponse(cancelId));
    // Text-only replies have no audio buffer to clear.
    if (this.state.mode === "voice") {
      const clearId = newEventId();
      this.dispatch({ type: "benign", eventId: clearId });
      this.send(clearOutputAudio(clearId));
    }
  }

  // -------------------------------------------------------------- state

  private dispatch(action: Action): void {
    const prev = this.state;
    const next = reducer(prev, action);
    if (next === prev) return;
    this.state = next;

    const status = next.connection.status;
    if (status === "ended" || status === "failed") {
      // Terminal: whatever caused it, nothing may stay open.
      this.cleanup();
    } else if (
      status === "connected" &&
      (prev.activity !== next.activity ||
        prev.order.length !== next.order.length)
    ) {
      this.armIdle();
    }
    for (const l of [...this.listeners]) l();
  }

  private fail(
    code: FailureCode,
    retryAfterSeconds?: number,
    fromReconnect = false,
  ): void {
    this.finish({
      status: "failed",
      code,
      ...(fromReconnect && { fromReconnect }),
      ...(retryAfterSeconds !== undefined && {
        retryAfterSeconds,
        retryAt: this.deps.now() + retryAfterSeconds * 1000,
      }),
    });
  }

  private finish(
    connection: Extract<ConnectionState, { status: "ended" | "failed" }>,
  ): void {
    const status = this.state.connection.status;
    if (status === "idle" || status === "ended" || status === "failed") return;
    this.dispatch({ type: "connection", connection });
  }

  // ------------------------------------------------------------- timers

  private startTimers(maxSeconds: number): void {
    const capMs = maxSeconds * 1000;
    if (capMs > CAP_WARNING_MS) {
      this.setTimer("capWarning", capMs - CAP_WARNING_MS, () =>
        this.dispatch({
          type: "notice",
          notice: { kind: "cap_warning", secondsLeft: CAP_WARNING_MS / 1000 },
        }),
      );
    }
    this.capDeadline = this.deps.now() + capMs;
    this.setTimer("cap", capMs, () =>
      this.finish({ status: "ended", reason: "max_duration" }),
    );
    this.armIdle();

    const vis = this.deps.visibility;
    const onVisibility = () => {
      if (vis.isHidden()) {
        this.hiddenSince ??= this.deps.now();
        this.setTimer("hidden", HIDDEN_MS, () =>
          this.finish({ status: "ended", reason: "hidden" }),
        );
        return;
      }
      const hiddenFor =
        this.hiddenSince === null ? 0 : this.deps.now() - this.hiddenSince;
      this.hiddenSince = null;
      this.clearTimer("hidden");
      // Back in the foreground: the hidden timer may never have run.
      if (hiddenFor >= HIDDEN_MS) {
        this.finish({ status: "ended", reason: "hidden" });
        return;
      }
      this.checkDeadlines();
    };
    this.offVisibility = vis.subscribe(onVisibility);
    onVisibility();
  }

  /**
   * Idle means no speech and no response for IDLE_MS; any change in activity
   * or the transcript restarts it. Someone talking, or an answer being
   * spoken, is never idle. "Thinking" is not protected: if no answer has
   * started after two minutes, something is wrong and the chat should end.
   */
  private armIdle(): void {
    this.lastActivityAt = this.deps.now();
    this.setTimer("idle", IDLE_MS, () => {
      // A chat that is reconnecting is not idle: nobody can speak into it.
      if (this.isBusy() || this.state.connection.status === "reconnecting") {
        this.armIdle();
      } else this.finish({ status: "ended", reason: "idle" });
    });
  }

  private isBusy(): boolean {
    const s = this.state;
    return (
      s.activity === "userSpeaking" ||
      s.activity === "assistantSpeaking" ||
      s.response.audioId !== null
    );
  }

  /** The cap and idle limits, judged by the clock rather than by timers that may have been frozen. */
  private checkDeadlines(): void {
    const now = this.deps.now();
    if (this.capDeadline !== null && now >= this.capDeadline) {
      this.finish({ status: "ended", reason: "max_duration" });
    } else if (
      now - this.lastActivityAt >= IDLE_MS &&
      !this.isBusy() &&
      this.state.connection.status !== "reconnecting"
    ) {
      this.finish({ status: "ended", reason: "idle" });
    }
  }

  private setTimer(name: TimerName, ms: number, fn: () => void): void {
    this.clearTimer(name);
    this.timers[name] = setTimeout(() => {
      delete this.timers[name];
      fn();
    }, ms);
  }

  private clearTimer(name: TimerName): void {
    const t = this.timers[name];
    if (t !== undefined) clearTimeout(t);
    delete this.timers[name];
  }

  // ------------------------------------------------------------- levels

  /** Connects the stable listener sets to the current meter. */
  private bindLevels(): void {
    const meter = this.res.meter;
    for (const kind of ["mic", "remote"] as const) {
      const wanted = this.levelListeners[kind].size > 0;
      const bound = this.levelOffs[kind] !== null;
      if (bound && (!wanted || !meter)) {
        this.levelOffs[kind]?.();
        this.levelOffs[kind] = null;
      }
      if (wanted && meter && !this.levelOffs[kind]) {
        this.levelOffs[kind] = meter.subscribe(kind, (level) => {
          for (const l of this.levelListeners[kind]) l(level);
        });
      }
    }
  }

  // ------------------------------------------------------------ cleanup

  /** Releases everything this session holds. Idempotent. */
  private cleanup(): void {
    this.runId += 1; // any step still awaiting sees it is stale
    for (const name of Object.keys(this.timers) as TimerName[]) {
      this.clearTimer(name);
    }
    this.offVisibility?.();
    this.offVisibility = null;
    this.hiddenSince = null;
    this.capDeadline = null;
    this.rc = null;
    this.ledger = EMPTY_LEDGER;
    this.micNeedsSwap = false;
    this.pendingSecret = null;
    this.newSession = false;

    const res = this.res;
    this.res = emptyResources();
    res.abort?.abort();
    res.transport?.close();
    res.micCleanup?.();
    stopStream(res.mic);
    for (const kind of ["mic", "remote"] as const) {
      this.levelOffs[kind]?.();
      this.levelOffs[kind] = null;
    }
    res.meter?.dispose();
    void res.audioContext?.close().catch(() => {});
    if (res.audioElement) this.deps.removeAudioElement(res.audioElement);
    // Bars drop to zero rather than freezing at the last value.
    for (const kind of ["mic", "remote"] as const) {
      for (const l of this.levelListeners[kind]) l(0);
    }
  }
}
