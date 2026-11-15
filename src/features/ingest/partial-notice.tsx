import { AlertCircle } from "lucide-react";
import { RetryButton } from "@/components/retry-button";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/features/document/format";
import type { DocumentData } from "./ingest-state";

/** What arrived before the connection broke, in the units the user knows. */
export function partialSummary(doc: DocumentData): string {
  const { meta } = doc;
  if (meta.sourceType === "pdf") {
    return `You have ${doc.pages.length} of ${meta.pages} pages.`;
  }
  const last = doc.segments[doc.segments.length - 1];
  if (!last) return "None of the captions arrived.";
  // startSec is where the last paragraph begins, not where it ends, so a
  // short stretch is "the start" and a longer one is "about" that far.
  if (last.startSec < 60) return "You have only the start of the captions.";
  return `You have about the first ${formatDuration(last.startSec)} of ${formatDuration(meta.durationSec)}.`;
}

/**
 * The stream broke after the document began. The pages that arrived stay on
 * screen, and the user chooses: load again, or start over.
 */
export function PartialNotice({
  doc,
  onRetry,
  onStartOver,
}: {
  doc: DocumentData;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  return (
    <div
      data-testid="partial-notice"
      className="flex flex-col gap-3 rounded-xl border border-warning/50 bg-warning/15 p-4"
    >
      <p role="alert" className="flex items-start gap-2 text-sm">
        <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0" />
        <span>The connection dropped. {partialSummary(doc)}</span>
      </p>
      <div className="flex gap-2">
        <Button variant="outline" className="h-11 flex-1" onClick={onStartOver}>
          Start over
        </Button>
        <RetryButton
          retryAt={undefined}
          label="Try again"
          onRetry={onRetry}
          className="h-11 flex-1"
        />
      </div>
    </div>
  );
}
