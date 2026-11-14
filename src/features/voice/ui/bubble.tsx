import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TranscriptItem } from "../realtime/state";

export function Bubble({
  item,
  onRetry,
}: {
  item: TranscriptItem;
  onRetry: (id: string) => void;
}) {
  const mine = item.role === "user";
  const placeholder =
    item.status === "transcribing" && item.text === ""
      ? "Transcribing…"
      : item.status === "transcriptionFailed"
        ? "Couldn't catch that. Try again."
        : null;
  return (
    <li
      data-testid={`item-${item.role}`}
      data-status={item.status}
      className={cn(
        "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-snug break-words",
        mine
          ? "ml-auto rounded-br-md bg-primary text-primary-foreground"
          : "mr-auto rounded-bl-md bg-muted",
      )}
    >
      {placeholder ? (
        <span className="italic opacity-80">{placeholder}</span>
      ) : (
        <>
          {item.text}
          {item.status === "interrupted" && (
            <span
              data-testid="interrupted-marker"
              className="mt-1 block text-xs font-medium text-muted-foreground"
            >
              — interrupted
            </span>
          )}
        </>
      )}
      {item.status === "sendFailed" && (
        <Button
          variant="link"
          className="h-11 px-0 text-primary-foreground underline"
          onClick={() => onRetry(item.id)}
        >
          Not sent. Tap to retry.
        </Button>
      )}
    </li>
  );
}
