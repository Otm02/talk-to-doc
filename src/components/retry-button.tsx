"use client";

import { Hourglass } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatWait,
  secondsUntil,
  spokenWait,
  useCountdown,
} from "@/lib/use-countdown";

// A retry that respects a server-given wait (a 429). The button counts down
// and re-enables itself at 0. Screen readers hear the wait once when it starts
// (InitialWait, inside the card's alert) and once when it ends (the status
// line here): a live region that changed every second would talk non-stop.

/**
 * Mount it with `key={retryAt}` inside the element that announces the error,
 * so the sentence is fixed for that wait and read out with the error itself.
 */
export function InitialWait({ retryAt }: { retryAt: number | undefined }) {
  const [initial] = useState(() =>
    retryAt === undefined ? 0 : secondsUntil(retryAt, Date.now()),
  );
  if (initial === 0) return null;
  return (
    <span className="sr-only" data-testid="retry-wait-start">
      {" "}
      You can try again in {spokenWait(initial)}.
    </span>
  );
}

/** Mount it with `key={retryAt}` so each new wait starts fresh. */
export function RetryButton({
  retryAt,
  label = "Try again",
  onRetry,
  className,
  ...button
}: {
  /** Deadline in ms since epoch; undefined = no wait. */
  retryAt: number | undefined;
  label?: string;
  onRetry: () => void;
} & Omit<ComponentProps<typeof Button>, "onClick" | "disabled" | "children">) {
  const { secondsLeft, done } = useCountdown(retryAt);
  // "You can try again now" is only news if this button made the user wait.
  const [waited] = useState(!done);
  return (
    <>
      <Button
        {...button}
        data-testid="retry-button"
        data-waiting={!done}
        disabled={!done}
        onClick={onRetry}
        className={cn(
          className,
          // The countdown is the one thing to read here, so a waiting button
          // is not faded like other disabled ones; it is outlined and quiet.
          !done &&
            "border-border bg-transparent text-foreground tabular-nums disabled:opacity-100",
        )}
      >
        {!done && <Hourglass aria-hidden />}
        {done ? label : `${label} in ${formatWait(secondsLeft)}`}
      </Button>
      <span role="status" className="sr-only" data-testid="retry-wait-end">
        {waited && done ? "You can try again now." : ""}
      </span>
    </>
  );
}
