import { MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MicBanner({
  detail,
  onRetry,
}: {
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="mic-banner"
      className="mx-4 flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning/15 p-3 text-warning-foreground"
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <MicOff aria-hidden className="mt-0.5 size-4 shrink-0" />
        Microphone unavailable, you&apos;re in text mode
      </p>
      <p className="text-sm opacity-90">{detail}</p>
      <Button variant="outline" className="h-11 self-start" onClick={onRetry}>
        Try microphone again
      </Button>
    </div>
  );
}
