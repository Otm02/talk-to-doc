import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Sticky bottom actions. Voice is wired in M7, so the primary stays disabled. */
export function ReadyBar({
  onUseAnother,
  voiceDisabled,
}: {
  onUseAnother: () => void;
  voiceDisabled: boolean;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-auto flex flex-col gap-2 border-t bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
      <Button className="h-12 text-base" disabled={voiceDisabled}>
        <Mic aria-hidden />
        Start voice chat
      </Button>
      <Button variant="outline" className="h-11" onClick={onUseAnother}>
        Use another source
      </Button>
    </div>
  );
}
