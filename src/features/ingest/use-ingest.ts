"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PageLine, SegmentLine } from "@/lib/wire/ingest";
import { IngestError, isAbortError } from "./ingest-error";
import { initialIngestState, ingestReducer, type IngestRequest } from "./ingest-state";
import { checkPdfFile } from "./validate-pdf";
import { readIngestEvents } from "./ndjson-reader";
import { getUploadMode, ingestPdf, ingestYoutube } from "./upload-client";

// Units arrive far faster than a phone can paint; batching keeps a
// 1,000-page file from causing a render per page.
const FLUSH_MS = 60;

/** One hook owns the ingest flow; components only render its state. */
export function useIngest() {
  const [state, dispatch] = useReducer(ingestReducer, initialIngestState);
  const controllerRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<IngestRequest | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const run = useCallback(async (request: IngestRequest) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    lastRequestRef.current = request;
    const { signal } = controller;

    let pages: PageLine[] = [];
    let segments: SegmentLine["segment"][] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (signal.aborted || (!pages.length && !segments.length)) return;
      dispatch({ type: "units", pages, segments });
      pages = [];
      segments = [];
    };

    try {
      let stream: ReadableStream<Uint8Array>;
      if (request.kind !== "youtube") {
        let file: File;
        if (request.kind === "pdf") {
          file = request.file;
        } else {
          dispatch({ type: "upload-start", fileName: request.name, size: 0 });
          const res = await fetch(request.url, { signal }).catch(() => null);
          if (!res?.ok) throw new IngestError("upload_failed", "Sample missing");
          file = new File([await res.blob()], request.name, {
            type: "application/pdf",
          });
        }
        // Same checks as the server, so a bad file never leaves the phone.
        const check = checkPdfFile(file);
        if (!check.ok) throw new IngestError(check.code, check.code);
        dispatch({ type: "upload-start", fileName: file.name, size: file.size });
        const mode = await getUploadMode();
        stream = await ingestPdf(file, mode, signal, {
          onUploadProgress: (percent) =>
            !signal.aborted && dispatch({ type: "upload-progress", percent }),
          onUploaded: () => !signal.aborted && dispatch({ type: "extract-start" }),
        });
      } else {
        dispatch({ type: "extract-start" });
        stream = await ingestYoutube(request.url, signal);
      }
      dispatch({ type: "extract-start" });

      const incomplete = request.kind !== "youtube" ? "upload_failed" : "youtube_failed";
      for await (const event of readIngestEvents(stream, incomplete)) {
        if (signal.aborted) return;
        switch (event.type) {
          case "meta":
            dispatch({ type: "meta", meta: event.meta });
            break;
          case "page":
            pages.push(event.page);
            timer ??= setTimeout(flush, FLUSH_MS);
            break;
          case "segment":
            segments.push(event.segment);
            timer ??= setTimeout(flush, FLUSH_MS);
            break;
          case "done":
            flush();
            dispatch({ type: "done", done: event.done });
            break;
          default: {
            const exhaustive: never = event;
            return exhaustive;
          }
        }
      }
    } catch (error) {
      if (timer) clearTimeout(timer);
      // Cancel is the user's own action: back to the start, no error card.
      if (signal.aborted || isAbortError(error)) {
        dispatch({ type: "reset" });
        return;
      }
      if (error instanceof IngestError) {
        dispatch({
          type: "fail",
          code: error.code,
          retryAfterSeconds: error.retryAfterSeconds,
        });
      } else {
        dispatch({ type: "fail", code: "internal" });
      }
    }
  }, []);

  const startPdf = useCallback((file: File) => run({ kind: "pdf", file }), [run]);
  const startSamplePdf = useCallback(
    (url: string, name: string) => run({ kind: "pdf-sample", url, name }),
    [run],
  );
  const startYoutube = useCallback(
    (url: string) => run({ kind: "youtube", url }),
    [run],
  );
  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    if (last) void run(last);
  }, [run]);
  const reset = useCallback(() => {
    cancel();
    lastRequestRef.current = null;
    dispatch({ type: "reset" });
  }, [cancel]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { state, startPdf, startSamplePdf, startYoutube, retry, cancel, reset };
}
