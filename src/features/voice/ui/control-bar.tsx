"use client";

import { Keyboard, Mic, MicOff, PhoneOff, Square } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EndConfirm } from "./end-confirm";

interface Props {
  muted: boolean;
  /** Voice mode with a live mic: Mute only makes sense then. */
  canMute: boolean;
  speaking: boolean;
  onToggleMute: () => void;
  onStopAnswer: () => void;
  /** Opens the composer; the screen then switches to its compact layout. */
  onOpenKeyboard: () => void;
  onEnd: () => void;
}

const BTN = "h-14 min-w-14 flex-col gap-0.5 rounded-2xl px-2 text-xs";

/**
 * Thumb-zone controls for a voice chat with the composer closed. Every target
 * is 56 px. With the composer open, the same controls sit in its row instead.
 */
export function ControlBar(p: Props) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div
        role="toolbar"
        aria-label="Chat controls"
        className="flex items-center justify-around gap-2 px-4 pt-2"
      >
        <Button
          variant="outline"
          className={cn(BTN, "flex-1")}
          disabled={!p.canMute}
          aria-pressed={p.muted}
          onClick={p.onToggleMute}
        >
          {p.muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}
          {p.muted ? "Unmute" : "Mute"}
        </Button>
        {p.speaking && (
          <Button
            variant="outline"
            className={cn(BTN, "flex-1")}
            onClick={p.onStopAnswer}
          >
            <Square aria-hidden />
            Stop answer
          </Button>
        )}
        <Button
          variant="outline"
          className={cn(BTN, "flex-1")}
          onClick={p.onOpenKeyboard}
        >
          <Keyboard aria-hidden />
          Keyboard
        </Button>
        <Button
          className={cn(
            BTN,
            "flex-1 bg-destructive-solid text-white hover:bg-destructive-solid/90",
          )}
          onClick={() => setConfirming(true)}
        >
          <PhoneOff aria-hidden />
          End
        </Button>
      </div>

      <EndConfirm
        open={confirming}
        onOpenChange={setConfirming}
        onEnd={p.onEnd}
      />
    </>
  );
}
