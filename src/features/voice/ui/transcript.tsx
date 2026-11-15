"use client";

import { ArrowDown } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type {
  ReferenceIndex,
  ReferenceTarget,
} from "@/features/document/references";
import type { RealtimeState } from "../realtime/state";
import { Bubble } from "./bubble";
import { useStickToBottom } from "./use-stick-to-bottom";

/** A line across the conversation where a lost connection was rebuilt. */
function ReconnectedDivider() {
  return (
    <li
      role="separator"
      aria-label="Reconnected"
      data-testid="reconnected-divider"
      className="flex items-center gap-2 py-1 text-xs font-medium text-muted-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      Reconnected
      <span aria-hidden className="h-px flex-1 bg-border" />
    </li>
  );
}

export function Transcript({
  state,
  onRetry,
  empty,
  references,
  onOpenReference,
  pinned,
  children,
}: {
  state: RealtimeState;
  onRetry: (id: string) => void;
  empty: string;
  references?: ReferenceIndex;
  onOpenReference?: (target: ReferenceTarget) => void;
  /** Short notices that must stay visible (time warning): stuck to the top. */
  pinned?: ReactNode;
  /** Longer notices (the mic coach): they scroll away with the conversation. */
  children?: ReactNode;
}) {
  const last = state.items[state.order[state.order.length - 1] ?? ""];
  // Streaming grows the last bubble without adding one, so watch its length too.
  const changeKey = `${state.order.length}:${last?.text.length ?? 0}:${last?.status ?? ""}`;
  const { ref, onScroll, behind, jump } = useStickToBottom(changeKey);

  return (
    <div data-testid="transcript-region" className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        // Focusable so a keyboard can scroll it; a region so the label is valid.
        tabIndex={0}
        role="region"
        aria-label="Conversation"
        className="flex h-full flex-col overflow-y-auto overscroll-contain px-4 py-2"
      >
        {pinned && (
          <div className="sticky top-0 z-10 -mx-1 flex flex-col gap-1 pb-2">
            {pinned}
          </div>
        )}
        {children && <div className="flex flex-col gap-2 pb-2">{children}</div>}
        {/* The log role goes on a wrapper: on the <ol> itself it would replace
            the list role and orphan every <li>. */}
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          data-testid="transcript"
          className="flex flex-1 flex-col justify-end"
        >
          <ol className="flex flex-col gap-2">
            {state.order.length === 0 && empty !== "" && (
              <li className="py-6 text-center text-sm text-muted-foreground">
                {empty}
              </li>
            )}
            {state.order.map((id, i) => {
              const item = state.items[id];
              if (!item) return null;
              const prev = state.items[state.order[i - 1] ?? ""];
              // The first item of a session that began with a reconnect.
              const divider =
                state.reconnectMarks.includes(item.epoch) &&
                prev?.epoch !== item.epoch;
              return (
                <Fragment key={id}>
                  {divider && <ReconnectedDivider />}
                  <Bubble
                    item={item}
                    onRetry={onRetry}
                    references={references}
                    onOpenReference={onOpenReference}
                  />
                </Fragment>
              );
            })}
            {/* Reconnected, and nothing said yet in the new session. */}
            {state.reconnectMarks.includes(state.epoch) &&
              !state.order.some(
                (id) => state.items[id]?.epoch === state.epoch,
              ) && <ReconnectedDivider />}
          </ol>
        </div>
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
