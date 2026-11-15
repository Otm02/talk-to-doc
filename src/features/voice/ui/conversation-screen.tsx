"use client";

import { FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FullTextSheet } from "@/features/document/full-text-sheet";
import { buildGroups } from "@/features/document/text-groups";
import type { DocumentData } from "@/features/ingest/ingest-state";
import { CostOverlay } from "../dev-cost/cost-overlay";
import { useDebug } from "../dev-cost/use-debug";
import { endReasonMessage, micFailureCode, failureMessage } from "../realtime/failure";
import type { Mode } from "../realtime/state";
import type { useVoiceSession } from "../realtime/use-voice-session";
import { Composer } from "./composer";
import { ControlBar } from "./control-bar";
import { FailureCard } from "./failure-card";
import { MicBanner } from "./mic-banner";
import { Orb } from "./orb";
import { SessionTimer, TimeWarning } from "./session-timer";
import { isInProgress, isLive, statusInfo } from "./status-map";
import { StatusPill } from "./status-pill";
import { Transcript } from "./transcript";
import { useKeyboardInset } from "./use-keyboard-inset";

export type VoiceSessionApi = ReturnType<typeof useVoiceSession>;

/** The full-screen chat. Owns layout only: the engine lives in the hook. */
export function ConversationScreen({
  doc,
  session,
  onStart,
  onEnd,
  onClose,
}: {
  doc: DocumentData;
  session: VoiceSessionApi;
  /** Called inside the tap, so the mic prompt keeps the user's gesture. */
  onStart: (mode: Mode) => void;
  /** The user confirmed End. */
  onEnd: () => void;
  onClose: () => void;
}) {
  const { state, actions, subscribeLevel, estimatedCost, model, maxSessionSeconds } = session;
  const debug = useDebug();
  const inset = useKeyboardInset();
  const [typing, setTyping] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const groups = useMemo(() => buildGroups(doc), [doc]);

  const c = state.connection;
  const live = isLive(state);
  const textMode = state.mode === "text";
  const showComposer = textMode || typing;
  const speaking = c.status === "connected" && state.activity === "assistantSpeaking";

  return (
    <div
      data-testid="conversation"
      style={{ paddingBottom: inset }}
      className="fixed inset-0 z-40 mx-auto flex h-dvh w-full max-w-md flex-col bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
    >
      <header className="flex min-h-14 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top)]">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{doc.meta.title}</h1>
        {live && (
          <SessionTimer key={state.epoch} maxSeconds={maxSessionSeconds} />
        )}
        <Button variant="outline" className="h-11" onClick={() => setTextOpen(true)}>
          <FileText aria-hidden />
          Text
        </Button>
      </header>

      {debug && (
        <div className="flex items-center gap-2 px-4 pt-2">
          <CostOverlay
            className="static z-auto max-w-none flex-1"
            cost={estimatedCost}
            model={model}
            responses={state.usage.responses}
          />
          <Button variant="outline" className="h-11 text-xs" onClick={actions.downloadEvents}>
            Events
          </Button>
        </div>
      )}

      <div className="flex flex-col items-center gap-3 py-3">
        <StatusPill info={statusInfo(state)} />
        {!textMode && (
          <div className={showComposer ? "scale-60 -my-8" : ""}>
            <Orb subscribeLevel={subscribeLevel} dimmed={state.muted || !live} />
          </div>
        )}
      </div>

      {state.micIssue && c.status !== "failed" && (
        <MicBanner
          detail={failureMessage(micFailureCode(state.micIssue))}
          onRetry={() => {
            actions.end();
            onStart("voice");
          }}
        />
      )}
      {state.notice?.kind === "cap_warning" && (
        <TimeWarning secondsLeft={state.notice.secondsLeft} />
      )}
      {state.notice?.kind === "error" && (
        <p role="status" className="mx-4 rounded-xl border bg-muted px-3 py-2 text-sm">
          The service reported a problem. You can keep going or end the chat.
        </p>
      )}

      <Transcript
        state={state}
        onRetry={actions.retryText}
        empty={textMode ? "Type a question about this document." : "Say something, or tap the keyboard."}
      />

      {c.status === "failed" && (
        <FailureCard
          code={c.code}
          retryAfterSeconds={c.retryAfterSeconds}
          onRetry={() => onStart(state.mode)}
        />
      )}
      {c.status === "ended" && (
        <EndedPanel
          message={endReasonMessage(c.reason, Math.round((maxSessionSeconds ?? 300) / 60))}
          onAgain={() => onStart("voice")}
          onClose={onClose}
        />
      )}
      {c.status === "failed" && (
        <div className="px-4 pt-2">
          <Button variant="outline" className="h-14 w-full" onClick={onClose}>
            Back to document
          </Button>
        </div>
      )}

      {showComposer && (c.status === "connected" || c.status === "reconnecting") && (
        <Composer
          onSend={actions.sendText}
          disabled={c.status !== "connected"}
          autoFocus={!textMode}
        />
      )}

      {isInProgress(state) && (
        <div className="pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <ControlBar
            muted={state.muted}
            canMute={live && !textMode}
            speaking={speaking}
            keyboardOpen={showComposer}
            keyboardLocked={textMode}
            onToggleMute={() => actions.setMuted(!state.muted)}
            onStopAnswer={actions.stopAnswer}
            onToggleKeyboard={() => setTyping((t) => !t)}
            onEnd={onEnd}
          />
        </div>
      )}

      <FullTextSheet
        open={textOpen}
        onOpenChange={setTextOpen}
        groups={groups}
        complete={doc.done !== null}
      />
    </div>
  );
}

function EndedPanel({
  message,
  onAgain,
  onClose,
}: {
  message: string | null;
  onAgain: () => void;
  onClose: () => void;
}) {
  return (
    <div data-testid="ended-panel" className="flex flex-col gap-2 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <Button className="h-14" onClick={onAgain}>
        Start a new chat
      </Button>
      <Button variant="outline" className="h-14" onClick={onClose}>
        Back to document
      </Button>
    </div>
  );
}
