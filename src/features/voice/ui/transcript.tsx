"use client";

import { ArrowDown } from "lucide-react";
import type { RealtimeState } from "../realtime/state";
import { Bubble } from "./bubble";
import { useStickToBottom } from "./use-stick-to-bottom";

export function Transcript({
  state,
  onRetry,
  empty,
}: {
  state: RealtimeState;
  onRetry: (id: string) => void;
  empty: string;
}) {
  const last = state.items[state.order[state.order.length - 1] ?? ""];
  // Streaming grows the last bubble without adding one, so watch its length too.
  const changeKey = `${state.order.length}:${last?.text.length ?? 0}:${last?.status ?? ""}`;
  const { ref, onScroll, behind, jump } = useStickToBottom(changeKey);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Conversation"
        className="h-full overflow-y-auto overscroll-contain px-4 py-2"
      >
        <ol
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          data-testid="transcript"
          className="flex min-h-full flex-col justify-end gap-2"
        >
          {state.order.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">{empty}</li>
          )}
          {state.order.map((id) => {
            const item = state.items[id];
            return item ? <Bubble key={id} item={item} onRetry={onRetry} /> : null;
          })}
        </ol>
      </div>
      {behind && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-2 left-1/2 flex h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-4 text-sm font-medium shadow-md"
        >
          <ArrowDown aria-hidden className="size-4" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
