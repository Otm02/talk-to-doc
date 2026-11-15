"use client";

import { useCallback, useSyncExternalStore } from "react";

// A wait until a wall-clock deadline. It never counts ticks: every reading is
// "deadline minus now", so a throttled background tab, a slept phone or a late
// timer cannot make it drift. The timer only decides when to look again.

export interface Countdown {
  /** Whole seconds left, rounded up; 0 once the deadline has passed. */
  secondsLeft: number;
  done: boolean;
}

export function secondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** "42s", "8m 58s", "7h 12m": short enough for a button. */
export function formatWait(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function unit(n: number, name: string): string {
  return `${n} ${name}${n === 1 ? "" : "s"}`;
}

/** The same wait in words, for a screen reader: "1 minute 12 seconds". */
export function spokenWait(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  if (s < 60) return unit(s, "second");
  if (s < 3600) {
    const rest = s % 60;
    const minutes = unit(Math.floor(s / 60), "minute");
    return rest === 0 ? minutes : `${minutes} ${unit(rest, "second")}`;
  }
  const rest = Math.floor((s % 3600) / 60);
  const hours = unit(Math.floor(s / 3600), "hour");
  return rest === 0 ? hours : `${hours} ${unit(rest, "minute")}`;
}

/**
 * Seconds left until `deadline` (ms since epoch), re-read once a second and
 * whenever the tab becomes visible again. null or undefined means no wait.
 */
export function useCountdown(
  deadline: number | null | undefined,
  now: () => number = Date.now,
): Countdown {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (deadline == null) return () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        const left = deadline - now();
        if (left <= 0) return;
        // Wake exactly when the rounded-up second changes.
        timer = setTimeout(
          () => {
            onChange();
            schedule();
          },
          left % 1000 || 1000,
        );
      };
      // Timers are frozen in a hidden tab; catch up the moment it is back.
      const onVisibility = () => {
        clearTimeout(timer);
        onChange();
        schedule();
      };
      schedule();
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    [deadline, now],
  );
  const read = useCallback(
    () => (deadline == null ? 0 : secondsUntil(deadline, now())),
    [deadline, now],
  );
  const secondsLeft = useSyncExternalStore(subscribe, read, read);
  return { secondsLeft, done: secondsLeft === 0 };
}
