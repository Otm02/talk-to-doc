"use client";

import { Keyboard, Mic, MicOff, PhoneOff, Square } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface Props {
  muted: boolean;
  /** Voice mode with a live mic: Mute only makes sense then. */
  canMute: boolean;
  speaking: boolean;
  keyboardOpen: boolean;
  /** Text mode always shows the composer. */
  keyboardLocked: boolean;
  onToggleMute: () => void;
  onStopAnswer: () => void;
  onToggleKeyboard: () => void;
  onEnd: () => void;
}

const BTN = "h-14 min-w-14 flex-col gap-0.5 rounded-2xl px-2 text-xs";

/** Thumb-zone controls. Every target is 56 px. */
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
          <Button variant="outline" className={cn(BTN, "flex-1")} onClick={p.onStopAnswer}>
            <Square aria-hidden />
            Stop answer
          </Button>
        )}
        <Button
          variant="outline"
          className={cn(BTN, "flex-1")}
          aria-pressed={p.keyboardOpen}
          disabled={p.keyboardLocked}
          onClick={p.onToggleKeyboard}
        >
          <Keyboard aria-hidden />
          Keyboard
        </Button>
        <Button
          variant="destructive"
          className={cn(BTN, "flex-1 bg-destructive text-white hover:bg-destructive/90")}
          onClick={() => setConfirming(true)}
        >
          <PhoneOff aria-hidden />
          End
        </Button>
      </div>

      <Sheet open={confirming} onOpenChange={setConfirming}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="gap-3 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetTitle>End this chat?</SheetTitle>
          <SheetDescription>
            Your conversation stays on screen until you leave.
          </SheetDescription>
          <Button
            className="h-14 bg-destructive text-white hover:bg-destructive/90"
            onClick={() => {
              setConfirming(false);
              p.onEnd();
            }}
          >
            End chat
          </Button>
          <Button variant="outline" className="h-14" onClick={() => setConfirming(false)}>
            Keep talking
          </Button>
        </SheetContent>
      </Sheet>
    </>
  );
}
