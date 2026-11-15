import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  parseReferences,
  type ReferenceIndex,
  type ReferenceTarget,
} from "@/features/document/references";
import { cn } from "@/lib/utils";
import type { TranscriptItem } from "../realtime/state";

/**
 * An answer's text, with "page 12" and "[04:05]" turned into chips that open
 * the full text at that spot. Only references that exist in the document are
 * chips; the rest of the text is rendered exactly as it arrived.
 */
function AnswerText({
  text,
  references,
  onOpenReference,
}: {
  text: string;
  references: ReferenceIndex;
  onOpenReference: (target: ReferenceTarget) => void;
}) {
  const parts = useMemo(
    () => parseReferences(text, references),
    [text, references],
  );
  return (
    <>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            data-testid="ref-chip"
            // Starts with the visible words, so voice control can target it.
            aria-label={`${part.text}, open in the full text`}
            onClick={() => onOpenReference(part.target)}
            // The pseudo-element makes the touch area about 32 px tall without
            // changing the sentence's line height. It cannot be the usual
            // 44 px: chips on two adjacent lines would then cover each other
            // (an e2e test caught exactly that). Inline targets are exempt
            // from the 24 px minimum of WCAG 2.5.8; this clears it anyway.
            className="relative mx-0.5 inline-flex items-center rounded-full border border-foreground/30 bg-background px-2 py-px align-baseline text-[0.9em] font-medium whitespace-nowrap text-foreground underline decoration-foreground/40 underline-offset-2 outline-none after:absolute after:-inset-x-1 after:-inset-y-1.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
          >
            {part.text}
          </button>
        ),
      )}
    </>
  );
}

export function Bubble({
  item,
  onRetry,
  references,
  onOpenReference,
}: {
  item: TranscriptItem;
  onRetry: (id: string) => void;
  /** With both of these, an answer's page and time references become chips. */
  references?: ReferenceIndex;
  onOpenReference?: (target: ReferenceTarget) => void;
}) {
  const mine = item.role === "user";
  const placeholder =
    item.status === "transcribing" && item.text === ""
      ? "Transcribing…"
      : item.status === "transcriptionFailed"
        ? "Couldn't catch that. Try again."
        : null;
  // The answer has started but has no words yet: dots, not an empty bubble.
  const waiting = !mine && item.status === "streaming" && item.text === "";
  return (
    <li
      data-testid={`item-${item.role}`}
      data-status={item.status}
      className={cn(
        // anywhere, not break-words: a URL or a 60-letter word must wrap even
        // when it is the only thing on its line.
        "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] [overflow-wrap:anywhere]",
        mine
          ? "ml-auto rounded-br-md bg-primary leading-snug text-primary-foreground"
          : // A little more leading, so chips on adjacent lines keep apart.
            "mr-auto rounded-bl-md bg-muted leading-relaxed",
      )}
    >
      {!waiting && (
        <span className="sr-only">{mine ? "You: " : "Assistant: "}</span>
      )}
      {waiting ? (
        // Decorative: the status pill already says "Thinking" out loud.
        <span
          data-testid="typing-dots"
          aria-hidden
          className="inline-flex gap-1 py-1.5"
        >
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              style={{ animationDelay: `${delay}ms` }}
              className="size-1.5 rounded-full bg-current opacity-60 motion-safe:animate-pulse"
            />
          ))}
        </span>
      ) : placeholder ? (
        <span className="italic opacity-80">{placeholder}</span>
      ) : (
        <>
          {!mine && references && onOpenReference ? (
            <AnswerText
              text={item.text}
              references={references}
              onOpenReference={onOpenReference}
            />
          ) : (
            item.text
          )}
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
