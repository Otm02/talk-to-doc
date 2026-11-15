"use client";

import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export const WARN_AT_SECONDS = 60;

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Elapsed time while connected. Turns amber and says so when a minute is left. */
export function SessionTimer({
  maxSeconds,
  quiet = false,
  now = Date.now,
}: {
  maxSeconds: number | null;
  /**
   * The slim header has room for the title, the pill and the menu only: the
   * clock stays mounted (it counts from its first render) but out of sight,
   * until the last minute makes it worth the space.
   */
  quiet?: boolean;
  /** Injected so tests control the clock. */
  now?: () => number;
}) {
  // Mount it when the chat connects (keyed by epoch): it counts from then.
  const [startedAt] = useState(now);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = (now() - startedAt) / 1000;
  const left = maxSeconds === null ? null : maxSeconds - elapsed;
  const warn = left !== null && left <= WARN_AT_SECONDS;

  return (
    <span
      data-testid="session-timer"
      data-warning={warn}
      className={cn(
        "shrink-0 items-center gap-1 text-sm tabular-nums",
        quiet && !warn ? "hidden" : "inline-flex",
        warn ? "font-medium text-warning-foreground" : "text-muted-foreground",
      )}
    >
      <Clock aria-hidden className="size-4" />
      {formatClock(elapsed)}
      {warn && <span className="sr-only"> , under a minute left</span>}
    </span>
  );
}

export function TimeWarning({ secondsLeft }: { secondsLeft: number }) {
  return (
    <p
      role="status"
      data-testid="time-warning"
      className="mx-4 rounded-xl border border-warning/50 bg-warning/15 px-3 py-2 text-sm text-warning-foreground"
    >
      About {Math.max(1, Math.round(secondsLeft / 60))} minute left in this
      chat.
    </p>
  );
}
