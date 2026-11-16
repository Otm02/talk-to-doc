"use client";

import {
  Ellipsis,
  FileText,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  FullTextSheet,
  type TextFocus,
} from "@/features/document/full-text-sheet";
import {
  buildReferenceIndex,
  type ReferenceTarget,
} from "@/features/document/references";
import { buildGroups } from "@/features/document/text-groups";
import type { DocumentData } from "@/features/ingest/ingest-state";
import { canonicalUrl } from "@/lib/youtube/parseUrl";
import { cn } from "@/lib/utils";
import { CostOverlay } from "../dev-cost/cost-overlay";
import { useDebug } from "../dev-cost/use-debug";
import {
  useTranscriptExport,
  type TranscriptExportApi,
} from "../export/use-transcript-export";
import { endReasonMessage } from "../realtime/failure";
import type { Mode } from "../realtime/state";
import type { useVoiceSession } from "../realtime/use-voice-session";
import { Composer } from "./composer";
import { ControlBar } from "./control-bar";
import { EndConfirm } from "./end-confirm";
import { ExportButtons } from "./export-buttons";
import { useAnnounceChatOpen } from "@/components/chat-open";
import { OfflineBanner } from "@/components/offline-banner";
import { FailureCard } from "./failure-card";
import { ReconnectNotice } from "./reconnect-notice";
import { LevelDot } from "./level-dot";
import { MicBanner } from "./mic-banner";
import { Orb } from "./orb";
import { SessionMenu } from "./session-menu";
import { SessionTimer, TimeWarning } from "./session-timer";
import { isInProgress, isLive, statusInfo } from "./status-map";
import { StatusPill } from "./status-pill";
import { Transcript } from "./transcript";
import { useCompactLayout } from "./use-compact-layout";
import { useOnline } from "@/lib/net/use-online";

export type VoiceSessionApi = ReturnType<typeof useVoiceSession>;

/** What the transcript export names as the source: the file, or the video's URL. */
function sourceOf(doc: DocumentData): string {
  return doc.meta.sourceType === "youtube"
    ? canonicalUrl(doc.meta.videoId)
    : (doc.fileName ?? doc.meta.title);
}

/**
 * The full-screen chat. Owns layout only: the engine lives in the hook.
 *
 * Two layouts. The roomy one (a voice chat with nothing open) has the orb and
 * a thumb-zone control bar. The compact one (composer open, keyboard up, or
 * text mode) gives everything it can to the transcript: one slim header with
 * the status pill in it, the orb reduced to a dot inside that pill, and the
 * controls folded into the composer row. The screen is sized from the visual
 * viewport, so it ends where the soft keyboard begins.
 */
export function ConversationScreen({
  doc,
  session,
  onStart,
  onReloadSource,
  onEnd,
  onClose,
}: {
  doc: DocumentData;
  session: VoiceSessionApi;
  /** Called inside the tap, so the mic prompt keeps the user's gesture. */
  onStart: (mode: Mode) => void;
  /** Loads the document again from the source the page still holds (it expired on the server). */
  onReloadSource?: () => void;
  /** The user confirmed End. */
  onEnd: () => void;
  onClose: () => void;
}) {
  const {
    state,
    actions,
    subscribeLevel,
    estimatedCost,
    model,
    maxSessionSeconds,
  } = session;
  // The page behind this overlay has its own offline banner; it steps aside.
  useAnnounceChatOpen();
  const debug = useDebug();
  const online = useOnline();
  const [typing, setTyping] = useState(false);
  // The screen stays mounted from one chat to the next, so a keyboard opened
  // in the last chat would open again, with the soft keyboard, in this one.
  const startChat = (mode: Mode) => {
    setTyping(false);
    onStart(mode);
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [focus, setFocus] = useState<TextFocus | null>(null);

  const groups = useMemo(() => buildGroups(doc), [doc]);
  const references = useMemo(
    () =>
      buildReferenceIndex(
        groups,
        doc.meta.sourceType === "youtube" ? doc.meta.durationSec : undefined,
      ),
    [groups, doc.meta],
  );
  const exportApi = useTranscriptExport({
    title: doc.meta.title,
    source: sourceOf(doc),
    model,
    state,
  });

  const c = state.connection;
  const live = isLive(state);
  const inProgress = isInProgress(state);
  const connected = c.status === "connected";
  const textMode = state.mode === "text";
  const showComposer = inProgress && (textMode || typing);
  const speaking = connected && state.activity === "assistantSpeaking";
  const answering =
    connected &&
    (speaking ||
      state.activity === "thinking" ||
      state.response.activeId !== null);
  const { compact } = useCompactLayout({
    composerOpen: showComposer,
    textMode: inProgress && textMode,
  });
  // A chat that is over or could not start has no orb to show either.
  const slim = compact || !inProgress;
  const info = statusInfo(state, online);

  function openText(target: ReferenceTarget | null) {
    setFocus((prev) =>
      target ? { ...target, nonce: (prev?.nonce ?? 0) + 1 } : null,
    );
    setTextOpen(true);
  }

  const devTools = debug ? (
    <>
      <CostOverlay
        className="static z-auto max-w-none flex-1"
        cost={estimatedCost}
        model={model}
        responses={state.usage.responses}
      />
      <Button
        variant="outline"
        className="h-11 text-xs"
        onClick={actions.downloadEvents}
      >
        Events
      </Button>
    </>
  ) : null;

  const notices = (
    <>
      {state.notice?.kind === "cap_warning" && (
        <TimeWarning secondsLeft={state.notice.secondsLeft} />
      )}
      {state.notice?.kind === "error" && (
        <p
          role="status"
          className="rounded-xl border bg-muted px-3 py-2 text-sm shadow-sm"
        >
          The service reported a problem. You can keep going or end the chat.
        </p>
      )}
    </>
  );
  const hasNotice = state.notice !== null;

  const sentText = state.order.some((id) => {
    const item = state.items[id];
    return item?.role === "user" && item.source === "text";
  });
  const micBanner =
    state.micIssue && inProgress ? (
      <MicBanner
        reason={state.micIssue}
        working={state.micRetry === "working"}
        fails={state.micRetryFails}
        canRetry={connected}
        sentText={sentText}
        // Checks the mic first and only then touches the connection. It never
        // restarts the chat, so a mic that stays blocked costs no session.
        onRetry={actions.enableMic}
      />
    ) : null;

  return (
    <div
      data-testid="conversation"
      data-layout={slim ? "compact" : "full"}
      // --vvh / --vvt come from useCompactLayout: the visible area, which
      // stops at the top of the soft keyboard. The fallbacks cover browsers
      // without visualViewport.
      style={{ top: "var(--vvt, 0px)", height: "var(--vvh, 100dvh)" }}
      className="fixed inset-x-0 z-40 mx-auto flex w-full max-w-md flex-col bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b pt-[env(safe-area-inset-top)] pr-1 pl-4",
          slim ? "min-h-11" : "min-h-14",
        )}
      >
        <h1
          className={cn(
            "min-w-0 flex-1 truncate font-semibold",
            slim ? "text-sm" : "text-base",
          )}
        >
          {doc.meta.title}
        </h1>
        {/* Always in the same place while live, so it keeps counting when the layout changes. */}
        {live && (
          <SessionTimer
            // Per chat, not per session: a reconnect must not restart the clock.
            key={state.chatSeq}
            maxSeconds={maxSessionSeconds}
            quiet={slim}
          />
        )}
        {slim ? (
          <StatusPill info={info} className="h-7 px-2.5 text-[13px]">
            {live && !textMode && !state.muted ? (
              <LevelDot subscribeLevel={subscribeLevel} />
            ) : undefined}
          </StatusPill>
        ) : (
          <Button
            variant="outline"
            className="h-11"
            onClick={() => openText(null)}
          >
            <FileText aria-hidden />
            Text
          </Button>
        )}
        <Button
          variant="ghost"
          className="size-11"
          aria-label="More"
          aria-haspopup="dialog"
          onClick={() => setMenuOpen(true)}
        >
          <Ellipsis aria-hidden className="size-5" />
        </Button>
      </header>

      {/* While reconnecting the notice says why; otherwise a lost link still shows. */}
      {c.status === "reconnecting" ? (
        <ReconnectNotice connection={c} />
      ) : (
        inProgress && <OfflineBanner className="shrink-0" />
      )}

      {!slim && (
        <>
          {devTools && (
            <div
              data-testid="debug-strip"
              className="flex items-center gap-2 px-4 pt-2"
            >
              {devTools}
            </div>
          )}
          <div className="flex shrink-0 animate-in flex-col items-center gap-3 py-3 duration-150 fade-in zoom-in-95">
            <StatusPill info={info} />
            <Orb
              subscribeLevel={subscribeLevel}
              dimmed={state.muted || !live}
            />
          </div>
          {hasNotice && (
            <div className="flex flex-col gap-2 px-4 pb-1">{notices}</div>
          )}
        </>
      )}

      <Transcript
        state={state}
        onRetry={actions.retryText}
        references={references}
        onOpenReference={openText}
        empty={
          // Only a chat that is running can be talked or typed to.
          !inProgress
            ? ""
            : textMode
              ? "Type a question about this document."
              : "Say something, or tap the keyboard."
        }
        // In the compact layout nothing but the header and the composer row
        // takes fixed height: notices live inside the scroll area.
        pinned={slim && hasNotice ? notices : undefined}
      >
        {micBanner}
      </Transcript>

      {c.status === "failed" && (
        <div className="flex shrink-0 flex-col gap-2 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <FailureCard
            code={c.code}
            retryAt={c.retryAt}
            // A failure from rebuilding the link keeps the transcript and sends
            // it along; a failed first start has none and starts over.
            onRetry={
              c.fromReconnect ? actions.reconnect : () => startChat(state.mode)
            }
            onSwitchToText={actions.switchToText}
            onReloadSource={onReloadSource}
          />
          <div className="px-4">
            <Button variant="outline" className="h-12 w-full" onClick={onClose}>
              Back to document
            </Button>
          </div>
        </div>
      )}
      {c.status === "ended" && (
        <EndedPanel
          message={endReasonMessage(
            c.reason,
            Math.round((maxSessionSeconds ?? 300) / 60),
          )}
          exportApi={exportApi}
          onAgain={() => startChat("voice")}
          onClose={onClose}
        />
      )}

      {showComposer && (
        <Composer
          onSend={actions.sendText}
          disabled={!connected}
          autoFocus={!textMode}
          canStop={answering}
          onStop={actions.stopAnswer}
          leading={
            textMode ? (
              <Button
                type="button"
                variant="outline"
                className="size-11"
                aria-label="Turn on microphone"
                aria-busy={state.micRetry === "working"}
                disabled={!connected}
                onClick={actions.enableMic}
              >
                {state.micRetry === "working" ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <MicOff aria-hidden />
                )}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="size-11"
                aria-label={state.muted ? "Unmute" : "Mute"}
                aria-pressed={state.muted}
                disabled={!live}
                onClick={() => actions.setMuted(!state.muted)}
              >
                {state.muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
              </Button>
            )
          }
          trailing={
            <Button
              type="button"
              aria-label="End"
              className="size-11 bg-destructive-solid text-white hover:bg-destructive-solid/90"
              onClick={() => setConfirmingEnd(true)}
            >
              <PhoneOff aria-hidden />
            </Button>
          }
        />
      )}

      {inProgress && !showComposer && (
        <div className="shrink-0 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <ControlBar
            muted={state.muted}
            canMute={live}
            speaking={speaking}
            onToggleMute={() => actions.setMuted(!state.muted)}
            onStopAnswer={actions.stopAnswer}
            onOpenKeyboard={() => setTyping(true)}
            onEnd={onEnd}
          />
        </div>
      )}

      <EndConfirm
        open={confirmingEnd}
        onOpenChange={setConfirmingEnd}
        onEnd={onEnd}
      />
      <SessionMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={doc.meta.title}
        exportApi={exportApi}
        onShowText={() => openText(null)}
        onHideKeyboard={
          showComposer && !textMode ? () => setTyping(false) : undefined
        }
        // The strip is hidden in the compact layout; this is its way back.
        debug={slim ? devTools : null}
      />
      <FullTextSheet
        open={textOpen}
        onOpenChange={setTextOpen}
        groups={groups}
        complete={doc.done !== null}
        focus={focus}
      />
    </div>
  );
}

function EndedPanel({
  message,
  exportApi,
  onAgain,
  onClose,
}: {
  message: string | null;
  exportApi: TranscriptExportApi;
  onAgain: () => void;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="ended-panel"
      className="flex shrink-0 flex-col gap-2 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {exportApi.canExport && <ExportButtons api={exportApi} layout="pair" />}
      <Button className="h-12" onClick={onAgain}>
        Start a new chat
      </Button>
      <Button variant="outline" className="h-12" onClick={onClose}>
        Back to document
      </Button>
    </div>
  );
}
