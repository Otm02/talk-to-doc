"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { estimateCost } from "./cost";
import type { Mode } from "./state";
import { VoiceSession, type SessionDeps } from "./session";
import { createBrowserDeps } from "./session-deps";

/**
 * The one hook over the engine. Components get state to render and actions to
 * call; they hold no protocol logic. The session ends itself when the
 * component unmounts or the document changes.
 */
export function useVoiceSession(
  documentId: string,
  options: { deps?: SessionDeps } = {},
) {
  const { deps } = options;
  const session = useMemo(
    () => new VoiceSession(documentId, deps ?? createBrowserDeps()),
    [documentId, deps],
  );
  // Safe to run twice (React strict mode): ending a chat that is not live is a no-op.
  useEffect(() => () => session.detach(), [session]);

  const state = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState,
  );

  const actions = useMemo(
    () => ({
      start: (mode: Mode) => session.start(mode),
      end: () => session.end(),
      /** "Reconnect" on Connection lost: one new session, transcript kept. Call it from the tap. */
      reconnect: () => session.reconnect(),
      /** "Switch to text" on Connection lost: same, without a microphone. */
      switchToText: () => session.switchToText(),
      /** Text chat to voice chat, in place. Call it straight from the tap. */
      enableMic: () => session.enableMic(),
      setMuted: (muted: boolean) => session.setMuted(muted),
      stopAnswer: () => session.stopAnswer(),
      sendText: (text: string) => session.sendText(text),
      retryText: (itemId: string) => session.retryText(itemId),
      /** Dev tools: save the raw event stream as JSONL (no-op without ?debug=1 or dev). */
      downloadEvents: () => session.recorder?.download(),
    }),
    [session],
  );

  return {
    state,
    actions,
    /** Feeds level bars without React state: write to a ref or a style. */
    subscribeLevel: session.subscribeLevel,
    /** null until the server has named the model, or for a model with no price table. */
    estimatedCost: session.model
      ? estimateCost(session.model, state.usage)
      : null,
    model: session.model,
    maxSessionSeconds: session.maxSessionSeconds,
  };
}
