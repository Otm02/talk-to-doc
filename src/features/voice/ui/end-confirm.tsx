"use client";

import { Button } from "@/components/ui/button";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnd: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
