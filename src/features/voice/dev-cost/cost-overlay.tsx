"use client";

import { cn } from "@/lib/utils";
import { formatUsd, type CostEstimate } from "../realtime/cost";
import { PRICES_FETCHED } from "../realtime/prices";
import { useDebug } from "./use-debug";

/**
 * Dev-only: what this chat has cost so far, estimated from the usage blocks
 * on response.done and transcription events. Shown in development or with
 * ?debug=1. It reads what the browser already has and reports nothing.
 */
export function CostOverlay({
  cost,
  model,
  responses,
  className,
}: {
  cost: CostEstimate | null;
  model: string | null;
  responses: number;
  /** Lets a screen place it in its own layout instead of floating over it. */
  className?: string;
}) {
  const debug = useDebug();
  if (!debug) return null;

  return (
    <details
      data-testid="cost-overlay"
      className={cn(
        "fixed top-[max(0.5rem,env(safe-area-inset-top))] right-2 z-50 max-w-[calc(100vw-1rem)] rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-md backdrop-blur",
        className,
      )}
    >
      <summary className="flex min-h-9 cursor-pointer items-center gap-2 font-mono">
        <span data-testid="cost-total" className="font-semibold">
          {cost ? formatUsd(cost.usd) : "n/a"}
        </span>
        <span data-testid="cost-tokens" className="text-muted-foreground">
          {cost
            ? `${cost.tokens.toLocaleString("en-US")} tok`
            : "no price table"}
        </span>
        <span className="text-muted-foreground">dev estimate</span>
      </summary>
      <div className="mt-2 space-y-1 font-mono">
        <p className="text-muted-foreground">
          {model ?? "no model yet"} · {responses} response
          {responses === 1 ? "" : "s"}
        </p>
        {cost?.lines.map((l) => (
          <p key={l.label} className="flex justify-between gap-4">
            <span>{l.label}</span>
            <span>
              {l.tokens.toLocaleString("en-US")} · {formatUsd(l.usd)}
            </span>
          </p>
        ))}
        <p className="text-muted-foreground">
          Prices as of {PRICES_FETCHED}. Not sent anywhere.
        </p>
      </div>
    </details>
  );
}
