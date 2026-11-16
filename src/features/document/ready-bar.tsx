import { Keyboard, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Sticky bottom actions. Start is called from the tap itself (mic permission). */
export function ReadyBar({
  onUseAnother,
  onStartVoice,
  onStartText,
}: {
  onUseAnother: () => void;
  onStartVoice: () => void;
  onStartText: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-auto flex flex-col gap-2 border-t bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
      <Button className="h-12 text-base" onClick={onStartVoice}>
        <Mic aria-hidden />
        Start voice chat
      </Button>
      <div className="flex gap-2">
        <Button variant="outline" className="h-11 flex-1" onClick={onStartText}>
          <Keyboard aria-hidden />
          Type instead
        </Button>
        <Button
          variant="outline"
          className="h-11 flex-1"
          onClick={onUseAnother}
        >
          Use another source
        </Button>
      </div>
    </div>
  );
}
