"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ReadyBar } from "@/features/document/ready-bar";
import type { DocumentData } from "@/features/ingest/ingest-state";
import type { Mode } from "../realtime/state";
import { useVoiceSession } from "../realtime/use-voice-session";
import { ConversationScreen } from "./conversation-screen";
import { isInProgress, isLive } from "./status-map";
import { useWakeLock } from "./use-wake-lock";

function buzz() {
  // Not on iOS Safari; a missing vibrate is fine.
  if (typeof navigator !== "undefined") navigator.vibrate?.(10);
}

/**
 * Wraps the ready document: the document view with its Start buttons, and the
 * full-screen chat once a chat is started. Start is called straight from the
 * tap so the mic prompt and audio unlock keep the user's gesture.
 */
export function VoiceChat({
  doc,
  onUseAnother,
  onReloadSource,
  children,
}: {
  doc: DocumentData;
  onUseAnother: () => void;
  /** Loads the same source again, for a document that expired on the server. */
  onReloadSource?: () => void;
  children: ReactNode;
}) {
  const session = useVoiceSession(doc.meta.documentId);
  const [open, setOpen] = useState(false);
  const { state, actions } = session;
  const active = isInProgress(state);

  useWakeLock(isLive(state));

  // Leaving the page mid-chat would drop the connection without asking.
  useEffect(() => {
    if (!active) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [active]);

  function start(mode: Mode) {
    actions.start(mode);
    setOpen(true);
    buzz();
  }

  function end() {
    actions.end();
    buzz();
  }

  function close() {
    actions.end();
    setOpen(false);
  }

  return (
    <>
      {children}
      <ReadyBar
        onUseAnother={onUseAnother}
        onStartVoice={() => start("voice")}
        onStartText={() => start("text")}
      />
      {open && (
        <ConversationScreen
          doc={doc}
          session={session}
          onStart={start}
          onReloadSource={onReloadSource}
          onEnd={end}
          onClose={close}
        />
      )}
    </>
  );
}
