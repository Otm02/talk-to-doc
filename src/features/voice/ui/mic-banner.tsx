"use client";

import { ChevronDown, Loader2, Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  failureMessage,
  micFailureCode,
  type MicFailure,
} from "../realtime/failure";
import { micCoach } from "./mic-coach";

const noStore = () => () => {};

/** Empty on the server and while hydrating, so the copy never mismatches. */
function useUserAgent(): string {
  return useSyncExternalStore(
    noStore,
    () => navigator.userAgent,
    () => "",
  );
}

// A page on http, or a browser with no getUserMedia: no setting fixes that.
const NO_STEPS: ReadonlySet<MicFailure> = new Set(["insecure", "unsupported"]);

/**
 * Why the chat is in text mode, and how to get the mic back. The retry button
 * never goes away and never restarts the chat: it checks the mic first, and
 * only a mic that works touches the connection. After a retry that found no
 * mic, the exact taps to change the browser setting open by themselves.
 */
export function MicBanner({
  reason,
  working,
  fails,
  canRetry,
  sentText,
  onRetry,
}: {
  reason: MicFailure;
  /** A retry is being checked right now. */
  working: boolean;
  /** Retries so far that found no mic. */
  fails: number;
  /** False while the chat is not connected: there is nothing to attach a mic to. */
  canRetry: boolean;
  /** The user has typed and sent a message in this chat. */
  sentText: boolean;
  onRetry: () => void;
}) {
  const coach = micCoach(useUserAgent());
  const hasSteps = !NO_STEPS.has(reason);
  // Closed until a retry fails; after that the user's own toggle wins.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = hasSteps && (toggled ?? fails > 0);

  // Someone who is typing has chosen text for now: fold the steps away so the
  // answer gets the room, once, on the first message. The toggle still reopens
  // them. (State adjusted during render, not in an effect, to avoid a flash.)
  const [sawSent, setSawSent] = useState(sentText);
  if (sentText !== sawSent) {
    setSawSent(sentText);
    if (sentText) setToggled(false);
  }

  // The banner scrolls with the conversation, so a retry made from further
  // down would otherwise fail with nothing visible changing.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fails > 0) root.current?.scrollIntoView?.({ block: "nearest" });
  }, [fails]);

  return (
    <div
      ref={root}
      data-testid="mic-banner"
      data-reason={reason}
      className="flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning/15 p-3 text-warning-foreground"
    >
      <div role="status" className="flex flex-col gap-1">
        <p className="flex items-start gap-2 text-sm font-medium">
          <MicOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          Microphone unavailable, you&apos;re in text mode
        </p>
        <p className="text-sm">{failureMessage(micFailureCode(reason))}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="h-11 text-foreground"
          disabled={!canRetry}
          aria-busy={working}
          onClick={onRetry}
        >
          {working ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <Mic aria-hidden />
          )}
          {working ? "Checking microphone…" : "Try microphone again"}
        </Button>
        {hasSteps && (
          <Button
            variant="ghost"
            className="h-11 text-warning-foreground"
            aria-expanded={open}
            aria-controls="mic-coach-steps"
            onClick={() => setToggled(!open)}
          >
            How to allow it
            <ChevronDown
              aria-hidden
              className={cn("transition-transform", open && "rotate-180")}
            />
          </Button>
        )}
      </div>

      {open && (
        <div id="mic-coach-steps" data-testid="mic-coach" className="text-sm">
          <ol className="flex list-decimal flex-col gap-1 pl-5">
            {coach.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-2">{coach.fallback}</p>
        </div>
      )}
    </div>
  );
}
