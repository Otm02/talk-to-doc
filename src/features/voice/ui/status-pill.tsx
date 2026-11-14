import { AudioLines, Brain, CircleOff, Loader2, Mic, MicOff, Square, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PillInfo, PillTone } from "./status-map";

const TONE: Record<PillTone, string> = {
  neutral: "border-border bg-muted text-foreground",
  active: "border-success/40 bg-success/10 text-success",
  speaking: "border-primary/40 bg-primary/10 text-foreground",
  warning: "border-warning/50 bg-warning/15 text-warning-foreground",
  error: "border-destructive/50 bg-destructive/10 text-destructive",
  ended: "border-border bg-muted text-muted-foreground",
};

function icon(label: string): ReactNode {
  const cls = "size-4";
  switch (label) {
    case "Connecting":
    case "Reconnecting":
      return <Loader2 aria-hidden className={cn(cls, "animate-spin")} />;
    case "Listening":
    case "You're speaking":
      return <Mic aria-hidden className={cls} />;
    case "Thinking":
      return <Brain aria-hidden className={cls} />;
    case "Speaking":
      return <AudioLines aria-hidden className={cls} />;
    case "Muted":
      return <MicOff aria-hidden className={cls} />;
    case "Offline":
      return <WifiOff aria-hidden className={cls} />;
    case "Ended":
      return <Square aria-hidden className={cls} />;
    default:
      return <CircleOff aria-hidden className={cls} />;
  }
}

/** Color plus an icon plus words: never color alone. */
export function StatusPill({ info }: { info: PillInfo }) {
  return (
    <span
      role="status"
      data-testid="status-pill"
      data-tone={info.tone}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium",
        TONE[info.tone],
      )}
    >
      {icon(info.label)}
      {info.label}
    </span>
  );
}
