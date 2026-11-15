import {
  AudioLines,
  Brain,
  CalendarClock,
  CircleAlert,
  CircleOff,
  CirclePause,
  Hourglass,
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  Square,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PillInfo, PillKind, PillTone } from "./status-map";

const TONE: Record<PillTone, string> = {
  neutral: "border-border bg-muted text-foreground",
  active: "border-success/40 bg-success/10 text-success",
  speaking: "border-primary/40 bg-primary/10 text-foreground",
  warning: "border-warning/50 bg-warning/15 text-warning-foreground",
  // The darker red: plain --destructive is 4:1 on its own 10% tint.
  error: "border-destructive/50 bg-destructive/10 text-destructive-text",
  ended: "border-border bg-muted text-muted-foreground",
};

const ICON: Record<PillKind, LucideIcon> = {
  ready: CircleOff,
  connecting: Loader2,
  reconnecting: Loader2,
  listening: Mic,
  userSpeaking: Mic,
  thinking: Brain,
  speaking: AudioLines,
  muted: MicOff,
  typing: MessageSquareText,
  cooldown: Hourglass,
  dailyLimit: CalendarClock,
  offline: WifiOff,
  unavailable: CirclePause,
  notConnected: CircleAlert,
  ended: Square,
};

const SPINS: ReadonlySet<PillKind> = new Set(["connecting", "reconnecting"]);

/** Color plus an icon plus words: never color alone. */
export function StatusPill({
  info,
  children,
  className,
}: {
  info: PillInfo;
  /** Replaces the icon, e.g. the level dot in the compact layout. */
  children?: ReactNode;
  className?: string;
}) {
  const Icon = ICON[info.kind];
  return (
    <span
      role="status"
      data-testid="status-pill"
      data-tone={info.tone}
      data-kind={info.kind}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap",
        TONE[info.tone],
        className,
      )}
    >
      {children ?? (
        <Icon
          aria-hidden
          className={cn("size-4", SPINS.has(info.kind) && "animate-spin")}
        />
      )}
      {info.label}
    </span>
  );
}
