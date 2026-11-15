"use client";

import { Loader2, WifiOff } from "lucide-react";
import { useState } from "react";
import { formatWait, spokenWait, useCountdown } from "@/lib/use-countdown";
import type { ConnectionState } from "../realtime/state";

type Reconnecting = Extract<ConnectionState, { status: "reconnecting" }>;

function Cooldown({ retryAt }: { retryAt: number | undefined }) {
  const { secondsLeft } = useCountdown(retryAt);
  // Read out once when it starts; the ticking number is for the eyes only.
  const [initial] = useState(secondsLeft);
  return (
    <>
      <span aria-hidden>
        Too many tries. Reconnecting in {formatWait(secondsLeft)}.
      </span>
      <span className="sr-only">
        Too many tries. Reconnecting in {spokenWait(initial)}.
      </span>
    </>
  );
}

/** What the reconnect is doing right now, in words. The pill says only the headline. */
export function ReconnectNotice({ connection }: { connection: Reconnecting }) {
  const offline = connection.phase === "waitingNetwork";
  const Icon = offline ? WifiOff : Loader2;
  return (
    <p
      role="status"
      data-testid="reconnect-notice"
      data-phase={connection.phase}
      className="flex shrink-0 items-center gap-2 border-b border-warning/50 bg-warning/15 px-4 py-2 text-sm text-warning-foreground"
    >
      <Icon
        aria-hidden
        className={
          offline
            ? "size-4 shrink-0"
            : "size-4 shrink-0 motion-safe:animate-spin"
        }
      />
      <span className="min-w-0">
        {connection.phase === "cooldown" ? (
          <Cooldown key={connection.retryAt} retryAt={connection.retryAt} />
        ) : connection.phase === "waitingNetwork" ? (
          <>{"You're offline. We'll reconnect when you're back."}</>
        ) : connection.phase === "grace" ? (
          <>Connection interrupted. Waiting for it to recover&hellip;</>
        ) : (
          <>
            Reconnecting&hellip; (attempt {connection.attempt} of{" "}
            {connection.maxAttempts})
          </>
        )}
      </span>
    </p>
  );
}
