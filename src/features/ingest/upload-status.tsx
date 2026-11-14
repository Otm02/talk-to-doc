import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes, formatDuration } from "@/features/document/format";
import type { IngestState } from "./ingest-state";

type Working = Extract<IngestState, { status: "uploading" | "extracting" }>;

function statusText(state: Working): string {
  if (state.status === "uploading") return "Uploading…";
  const meta = state.doc?.meta;
  if (!meta) return "Reading…";
  if (meta.sourceType === "pdf") {
    const read = state.doc?.pages.length ?? 0;
    return `Reading page ${Math.min(read + 1, Math.max(meta.pages, 1))} of ${meta.pages}…`;
  }
  return `Reading ${formatDuration(meta.durationSec)} of captions…`;
}

/** The stage text is the live region; the percent stays out of it so screen readers aren't flooded. */
export function UploadStatus({
  state,
  source,
  onCancel,
}: {
  state: Working;
  source: "pdf" | "youtube";
  onCancel: () => void;
}) {
  const text =
    state.status === "extracting" && !state.doc && source === "youtube"
      ? "Fetching captions…"
      : statusText(state);
  return (
    <div className="flex flex-col gap-3 rounded-xl border p-4">
      {state.status === "uploading" && (
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 truncate font-medium">{state.fileName}</span>
          {state.size > 0 && (
            <span className="shrink-0 text-muted-foreground">
              {formatBytes(state.size)}
            </span>
          )}
        </div>
      )}
      {state.status === "uploading" ? (
        <Progress value={state.percent} aria-label="Upload progress">
          <span aria-hidden className="ml-auto text-sm tabular-nums">
            {state.percent}%
          </span>
        </Progress>
      ) : (
        <Loader2 aria-hidden className="size-5 animate-spin text-muted-foreground" />
      )}
      <p role="status" aria-live="polite" className="text-sm">
        {text}
      </p>
      <Button variant="outline" className="h-11" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
