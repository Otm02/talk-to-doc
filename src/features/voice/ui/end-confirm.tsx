"use client";

import { Button } from "@/components/ui/button";
import { useHistoryLayer } from "@/lib/nav/use-history-layer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

/** End is one slip of the thumb away from Send, so it always asks first. */
export function EndConfirm({
  open,
  onOpenChange,
  onEnd,
  leaving = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnd: () => void;
  /** Asked because of Back: ending also leaves the chat. */
  leaving?: boolean;
}) {
  useHistoryLayer(open, () => onOpenChange(false));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-3 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetTitle>End this chat?</SheetTitle>
        <SheetDescription>
          {leaving
            ? "You will go back to the document, and this conversation is cleared."
            : "Your conversation stays on screen until you leave."}
        </SheetDescription>
        <Button
          className="h-14 bg-destructive-solid text-white hover:bg-destructive-solid/90"
          onClick={() => {
            onOpenChange(false);
            onEnd();
          }}
        >
          End chat
        </Button>
        <Button
          variant="outline"
          className="h-14"
          onClick={() => onOpenChange(false)}
        >
          Keep talking
        </Button>
      </SheetContent>
    </Sheet>
  );
}
