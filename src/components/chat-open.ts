"use client";

import { useEffect, useSyncExternalStore } from "react";

// Whether a chat screen is open. The chat is a fixed overlay over the page, so
// the page behind it is still in the document and still announces to screen
// readers; anything the page and the chat would both say (the offline banner)
// has to be said once. A counter, so two screens can never switch each other off.

let open = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call it in the chat screen: it counts as open for as long as it is mounted. */
export function useAnnounceChatOpen(): void {
  useEffect(() => {
    open += 1;
    emit();
    return () => {
      open -= 1;
      emit();
    };
  }, []);
}

export function useChatOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open > 0,
    () => false,
  );
}
