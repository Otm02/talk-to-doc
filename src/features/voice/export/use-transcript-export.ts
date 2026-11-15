"use client";

import { useCallback, useEffect, useState } from "react";
import type { RealtimeState } from "../realtime/state";
import { copyText, downloadMarkdown } from "./export-actions";
import {
  buildTranscriptMarkdown,
  transcriptFilename,
} from "./transcript-markdown";

export type ExportState = "idle" | "done" | "failed";

/** How long "Copied" or "Saved" stays up before the button reads normally again. */
export const EXPORT_FEEDBACK_MS = 2500;

function useFlash(): [ExportState, (next: ExportState) => void] {
  const [value, setValue] = useState<ExportState>("idle");
  useEffect(() => {
    if (value === "idle") return;
    const t = setTimeout(() => setValue("idle"), EXPORT_FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [value]);
  return [value, setValue];
}

/**
 * Copy and Download for the conversation on screen. One tap each: the file is
 * built at that moment from what the transcript shows.
 */
export function useTranscriptExport(input: {
  title: string;
  source: string;
  model: string | null;
  state: RealtimeState;
}) {
  const { title, source, model, state } = input;
  const [copyState, setCopyState] = useFlash();
  const [downloadState, setDownloadState] = useFlash();

  const build = useCallback(() => {
    const date = new Date();
    const items = state.order.flatMap((id) => state.items[id] ?? []);
    return {
      markdown: buildTranscriptMarkdown({ title, source, date, model, items }),
      filename: transcriptFilename(title, date),
    };
  }, [title, source, model, state.order, state.items]);

  const copy = useCallback(async () => {
    setCopyState((await copyText(build().markdown)) ? "done" : "failed");
  }, [build, setCopyState]);

  const download = useCallback(() => {
    const { filename, markdown } = build();
    setDownloadState(downloadMarkdown(filename, markdown) ? "done" : "failed");
  }, [build, setDownloadState]);

  return {
    /** Nothing said yet: there is nothing to export. */
    canExport: state.order.length > 0,
    copy,
    download,
    copyState,
    downloadState,
  };
}

export type TranscriptExportApi = ReturnType<typeof useTranscriptExport>;
