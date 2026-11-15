"use client";

import { Check, Copy, Download, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ExportState,
  TranscriptExportApi,
} from "../export/use-transcript-export";

function icon(state: ExportState, Idle: typeof Copy) {
  if (state === "done") return <Check aria-hidden />;
  if (state === "failed") return <TriangleAlert aria-hidden />;
  return <Idle aria-hidden />;
}

const COPY: Record<ExportState, string> = {
  idle: "Copy transcript",
  done: "Copied",
  // Says what to do instead: the other button does not need the clipboard.
  failed: "Copy failed. Use Download.",
};

const DOWNLOAD: Record<ExportState, string> = {
  idle: "Download transcript",
  done: "Saved as Markdown",
  failed: "Download failed. Use Copy.",
};

/**
 * Copy and Download, one tap each. `layout="rows"` is for the overflow menu
 * (full-width rows), `"pair"` for the ended panel (side by side).
 */
export function ExportButtons({
  api,
  layout,
}: {
  api: TranscriptExportApi;
  layout: "rows" | "pair";
}) {
  const rows = layout === "rows";
  const cls = rows
    ? "h-14 w-full justify-start gap-3 px-3 text-base"
    : "h-11 min-w-0 flex-1 px-2";
  return (
    <div
      className={cn("flex", rows ? "flex-col" : "gap-2")}
      data-testid="export-buttons"
    >
      <Button
        variant={rows ? "ghost" : "outline"}
        className={cls}
        disabled={!api.canExport}
        onClick={() => void api.copy()}
      >
        {icon(api.copyState, Copy)}
        <span className="truncate">
          {rows || api.copyState !== "idle" ? COPY[api.copyState] : "Copy"}
        </span>
      </Button>
      <Button
        variant={rows ? "ghost" : "outline"}
        className={cls}
        disabled={!api.canExport}
        onClick={api.download}
      >
        {icon(api.downloadState, Download)}
        <span className="truncate">
          {rows || api.downloadState !== "idle"
            ? DOWNLOAD[api.downloadState]
            : "Download"}
        </span>
      </Button>
      {/* The button text changes too, but a pressed button is not re-read. */}
      <span role="status" className="sr-only">
        {api.copyState !== "idle"
          ? COPY[api.copyState]
          : api.downloadState !== "idle"
            ? DOWNLOAD[api.downloadState]
            : ""}
      </span>
    </div>
  );
}
