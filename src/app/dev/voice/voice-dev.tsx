"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, Mic, MicOff, Send, Square, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CostOverlay } from "@/features/voice/dev-cost/cost-overlay";
import { useDebug } from "@/features/voice/dev-cost/use-debug";
import {
  endReasonMessage,
  failureMessage,
  micFailureCode,
} from "@/features/voice/realtime/failure";
import { useVoiceSession } from "@/features/voice/realtime/use-voice-session";

const noopSubscribe = () => () => {};

const ACTIVITY_LABEL = {
  listening: "Listening",
  userSpeaking: "Hearing you",
  thinking: "Thinking…",
  assistantSpeaking: "Speaking",
} as const;

/** Temporary harness: drives the engine by hand so it can be tried live. */
export function VoiceDev() {
  const search = useSyncExternalStore(
    noopSubscribe,
    () => window.location.search,
    () => "",
  );
  const params = new URLSearchParams(search);
  const mock = params.get("mockRealtime");
  const [typedId, setTypedId] = useState<string | null>(null);
  const docId = (typedId ?? params.get("doc") ?? "").trim();
  // The mock never asks the server, so it needs no real document.
  const sessionDocId = docId || (mock ? "mock-doc" : "");

  const {
    state,
    actions,
    subscribeLevel,
    estimatedCost,
    model,
    maxSessionSeconds,
  } = useVoiceSession(sessionDocId);
  const debug = useDebug();
  const [draft, setDraft] = useState("");
  const micBar = useRef<HTMLDivElement>(null);
  const remoteBar = useRef<HTMLDivElement>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  // Levels go straight to the DOM: no React state at animation-frame rate.
  useEffect(() => {
    const paint = (el: HTMLDivElement | null) => (level: number) => {
      if (el) el.style.transform = `scaleX(${level})`;
    };
    const offs = [
      subscribeLevel("mic", paint(micBar.current)),
      subscribeLevel("remote", paint(remoteBar.current)),
    ];
    return () => offs.forEach((off) => off());
  }, [subscribeLevel]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [state.order.length]);

  const { connection } = state;
  const status = connection.status;
  const canStart =
    sessionDocId !== "" &&
    (status === "idle" || status === "ended" || status === "failed");
  const live = status === "connected" || status === "reconnecting";
  const busy =
    state.activity === "thinking" || state.activity === "assistantSpeaking";
  const inProgress =
    status === "requestingMic" || status === "connecting" || live;

  const retryHint =
    connection.status === "failed" && connection.retryAfterSeconds
      ? ` Try again in ${connection.retryAfterSeconds} s.`
      : "";
  const message =
    connection.status === "failed"
      ? failureMessage(connection.code) + retryHint
      : connection.status === "ended"
        ? endReasonMessage(
            connection.reason,
            Math.round((maxSessionSeconds ?? 300) / 60),
          )
        : null;

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col gap-3 pb-16">
      <h1 className="text-lg font-semibold">Voice engine (dev)</h1>

      <label className="flex flex-col gap-1 text-sm">
        Document id
        <input
          data-testid="doc-id"
          className="h-11 rounded-lg border bg-background px-3 font-mono text-sm"
          placeholder="uuid from the ingest screen"
          value={typedId ?? params.get("doc") ?? ""}
          onChange={(e) => setTypedId(e.target.value)}
          disabled={inProgress}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>

      <div className="flex gap-2">
        <Button
          data-testid="start-voice"
          className="h-11 flex-1"
          disabled={!canStart}
          onClick={() => actions.start("voice")}
        >
          <Mic aria-hidden /> Start voice
        </Button>
        <Button
          data-testid="start-text"
          variant="outline"
          className="h-11 flex-1"
          disabled={!canStart}
          onClick={() => actions.start("text")}
        >
          <Type aria-hidden /> Start text
        </Button>
        <Button
          data-testid="end"
          variant="destructive"
          className="h-11"
          disabled={!inProgress}
          onClick={actions.end}
        >
          End
        </Button>
      </div>

      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
      >
        <span data-testid="status" className="font-mono font-semibold">
          {connection.status === "connecting"
            ? `connecting (${connection.phase})`
            : connection.status === "failed"
              ? `failed (${connection.code})`
              : connection.status === "ended"
                ? `ended (${connection.reason})`
                : connection.status}
        </span>
        {live && (
          <span data-testid="activity">
            {state.muted ? "Muted" : ACTIVITY_LABEL[state.activity]}
          </span>
        )}
        <span className="text-muted-foreground">mode {state.mode}</span>
        {model && <span className="text-muted-foreground">{model}</span>}
      </div>

      {message && (
        <p
          data-testid="message"
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {message}
        </p>
      )}
      {state.micIssue && (
        <p
          data-testid="mic-issue"
          className="rounded-lg border bg-muted p-3 text-sm"
        >
          {failureMessage(micFailureCode(state.micIssue))}
        </p>
      )}
      {state.notice?.kind === "cap_warning" && (
        <p
          data-testid="notice"
          className="rounded-lg border bg-muted p-3 text-sm"
        >
          {state.notice.secondsLeft} seconds left in this chat.
        </p>
      )}
      {state.notice?.kind === "error" && (
        <p
          data-testid="notice"
          className="rounded-lg border bg-muted p-3 text-sm"
        >
          The service reported a problem: <code>{state.notice.code}</code>
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <div>
          You
          <div className="mt-1 h-2 overflow-hidden rounded bg-muted">
            <div
              ref={micBar}
              data-testid="mic-level"
              className="h-full origin-left scale-x-0 bg-primary"
            />
          </div>
        </div>
        <div>
          Assistant
          <div className="mt-1 h-2 overflow-hidden rounded bg-muted">
            <div
              ref={remoteBar}
              data-testid="remote-level"
              className="h-full origin-left scale-x-0 bg-primary"
            />
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          data-testid="mute"
          variant="outline"
          className="h-11 flex-1"
          disabled={!live || state.mode === "text"}
          onClick={() => actions.setMuted(!state.muted)}
        >
          {state.muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
          {state.muted ? "Unmute" : "Mute"}
        </Button>
        <Button
          data-testid="stop"
          variant="outline"
          className="h-11 flex-1"
          disabled={status !== "connected" || !busy}
          onClick={actions.stopAnswer}
        >
          <Square aria-hidden /> Stop answer
        </Button>
        {debug && (
          <Button
            data-testid="download"
            variant="ghost"
            className="h-11"
            onClick={actions.downloadEvents}
            aria-label="Download raw events as JSONL"
          >
            <Download aria-hidden />
          </Button>
        )}
      </div>

      <ol
        data-testid="transcript"
        className="flex flex-1 flex-col gap-2"
        aria-label="Transcript"
      >
        {state.order.map((id) => {
          const item = state.items[id];
          if (!item) return null;
          return (
            <li
              key={id}
              data-testid={`item-${item.role}`}
              data-status={item.status}
              className={
                item.role === "user"
                  ? "ml-8 rounded-lg bg-primary/10 p-3 text-sm"
                  : "mr-8 rounded-lg bg-muted p-3 text-sm"
              }
            >
              <span className="block text-xs font-medium text-muted-foreground">
                {item.role === "user" ? "You" : "Assistant"}
              </span>
              {item.text}
              <span className="italic text-muted-foreground">
                {item.status === "transcribing" && item.text === ""
                  ? "transcribing…"
                  : ""}
                {item.status === "transcriptionFailed"
                  ? "couldn't transcribe"
                  : ""}
                {item.status === "interrupted" ? " (interrupted)" : ""}
                {item.status === "sending" ? " …" : ""}
                {item.status === "transcribing" && item.text !== "" ? " …" : ""}
              </span>
              {item.status === "sendFailed" && (
                <Button
                  data-testid="retry"
                  variant="link"
                  className="ml-2 h-11"
                  onClick={() => actions.retryText(item.id)}
                >
                  Not sent. Tap to retry.
                </Button>
              )}
            </li>
          );
        })}
        <div ref={transcriptEnd} />
      </ol>

      <form
        className="sticky bottom-0 flex gap-2 bg-background pt-2 pb-[env(safe-area-inset-bottom)]"
        onSubmit={(e) => {
          e.preventDefault();
          actions.sendText(draft);
          setDraft("");
        }}
      >
        <input
          data-testid="composer"
          className="h-11 flex-1 rounded-lg border bg-background px-3 text-base"
          placeholder="Ask about this document"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={status !== "connected"}
          enterKeyHint="send"
        />
        <Button
          data-testid="send"
          type="submit"
          className="h-11"
          disabled={status !== "connected" || draft.trim() === ""}
          aria-label="Send"
        >
          <Send aria-hidden />
        </Button>
      </form>

      <p data-testid="diagnostics" className="text-xs text-muted-foreground">
        unknown events {state.diagnostics.unknown} · malformed{" "}
        {state.diagnostics.malformed}
      </p>

      <CostOverlay
        cost={estimatedCost}
        model={model}
        responses={state.usage.responses}
      />
    </div>
  );
}
