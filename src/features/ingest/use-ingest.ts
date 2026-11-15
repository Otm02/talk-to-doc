"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  isOffline,
  markReachable,
  markUnreachable,
  waitForConnection,
} from "@/lib/net/connectivity";
import { retryOnce } from "@/lib/net/retry";
import { publicEnv } from "@/lib/public-env";
import { abortError, withTimeout } from "@/lib/net/timeout";
import type { PageLine, SegmentLine } from "@/lib/wire/ingest";
import { IngestError, StreamBrokenError } from "./ingest-error";
import {
  initialIngestState,
  ingestReducer,
  type IngestRequest,
} from "./ingest-state";
import { checkPdfFile } from "./validate-pdf";
import { readIngestEvents } from "./ndjson-reader";
import { getUploadMode, ingestPdf, ingestYoutube } from "./upload-client";

// Units arrive far faster than a phone can paint; batching keeps a
// 1,000-page file from causing a render per page.
const FLUSH_MS = 60;

/** No upload progress for this long: tell the user, and let them choose. */
export const UPLOAD_STALL_MS = 20_000;
/**
 * The stall threshold. Tests can shorten it with ?mockStallMs=<ms>, but only
 * in a dev or mock build, like the other mock flags.
 */
export function stallThresholdMs(
  search: string = globalThis.location?.search ?? "",
): number {
  if (publicEnv.isDev || publicEnv.realtimeTransport === "mock") {
    const ms = Number(new URLSearchParams(search).get("mockStallMs"));
    if (Number.isInteger(ms) && ms > 0) return ms;
  }
  return UPLOAD_STALL_MS;
}

/** How long the sample PDF may take to arrive. */
const SAMPLE_TIMEOUT_MS = 30_000;

/**
 * One hook owns the ingest flow; components only render its state.
 *
 * Failures that are the network's, not the server's, are handled for the
 * user: a YouTube stream that breaks is started again once, and a load that
 * got no answer waits for the connection and then runs again once. Anything
 * else stops with a visible Try again.
 */
export function useIngest() {
  const [state, dispatch] = useReducer(ingestReducer, initialIngestState);
  const controllerRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<IngestRequest | null>(null);
  const lastProgressRef = useRef(0);
  // One silent retry per tap, so a server that keeps cutting the stream cannot loop.
  const streamRetriedRef = useRef(false);
  const resumedRef = useRef(false);
  const waitRef = useRef<AbortController | null>(null);
  // run() starts itself again for the automatic retries; a ref keeps that
  // from being a reference to a value that is still being defined.
  const runAgainRef = useRef<(request: IngestRequest) => Promise<void>>(
    async () => {},
  );

  const stopWaiting = useCallback(() => {
    waitRef.current?.abort();
    waitRef.current = null;
  }, []);

  // Back to the start at once. It must not depend on the request noticing the
  // abort: on a stalled link that can take a long while.
  const cancel = useCallback(() => {
    stopWaiting();
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "reset" });
  }, [stopWaiting]);

  const run = useCallback(
    async (request: IngestRequest) => {
      stopWaiting();
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      lastRequestRef.current = request;
      lastProgressRef.current = Date.now();
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
        let fileName: string | undefined;
        if (request.kind !== "youtube") {
          let file: File;
          if (request.kind === "pdf") {
            file = request.file;
          } else {
            dispatch({
              type: "upload-start",
              fileName: request.name,
              size: 0,
            });
            file = await fetchSample(request.url, request.name, signal);
          }
          // Same checks as the server, so a bad file never leaves the phone.
          const check = checkPdfFile(file);
          if (!check.ok) throw new IngestError(check.code, check.code);
          dispatch({
            type: "upload-start",
            fileName: file.name,
            size: file.size,
          });
          lastProgressRef.current = Date.now();
          fileName = file.name;
          const mode = await getUploadMode(signal);
          stream = await ingestPdf(file, mode, signal, {
            onUploadProgress: (percent) => {
              if (signal.aborted) return;
              lastProgressRef.current = Date.now();
              dispatch({ type: "upload-progress", percent });
            },
            onUploaded: () =>
              !signal.aborted && dispatch({ type: "extract-start" }),
          });
        } else {
          // Also from a document already on screen (Load it again): it must
          // show as loading, not stay put with its buttons live.
          dispatch({ type: "load-start" });
          stream = await ingestYoutube(request.url, signal);
        }
        dispatch({ type: "extract-start" });

        const incomplete =
          request.kind !== "youtube" ? "upload_failed" : "youtube_failed";
        for await (const event of readIngestEvents(stream, incomplete)) {
          if (signal.aborted) return;
          switch (event.type) {
            case "meta":
              dispatch({ type: "meta", meta: event.meta, fileName });
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
        // Whatever arrived before the break is still good: show it first.
        flush();
        if (timer) clearTimeout(timer);
        // Cancelled, or replaced by a newer load: whoever did it has already
        // put the screen where it belongs, and a late word from this run
        // must not undo that.
        if (signal.aborted) return;
        const broken = error instanceof StreamBrokenError;

        // A YouTube stream that broke can simply be asked for again (the
        // server has the transcript cached), so do that once, quietly.
        if (
          broken &&
          request.kind === "youtube" &&
          !streamRetriedRef.current &&
          !isOffline()
        ) {
          streamRetriedRef.current = true;
          void runAgainRef.current(request);
          return;
        }

        const noAnswer = error instanceof IngestError && error.noAnswer;
        if (noAnswer) markUnreachable();

        if (broken) {
          dispatch({ type: "interrupt", code: error.code });
        } else if (error instanceof IngestError) {
          dispatch({
            type: "fail",
            code: error.code,
            retryAfterSeconds: error.retryAfterSeconds,
            // Fixed now, so the countdown reads the clock and cannot drift.
            retryAt:
              error.retryAfterSeconds === undefined
                ? undefined
                : Date.now() + error.retryAfterSeconds * 1000,
          });
        } else {
          dispatch({ type: "fail", code: "internal" });
        }

        // The network took it: wait for it to come back, then go again once.
        if (
          (noAnswer || (error instanceof IngestError && isOffline())) &&
          !resumedRef.current
        ) {
          resumedRef.current = true;
          const wait = new AbortController();
          waitRef.current = wait;
          waitForConnection(wait.signal).then(
            () => {
              if (wait.signal.aborted || controllerRef.current !== controller) {
                return;
              }
              waitRef.current = null;
              void runAgainRef.current(request);
            },
            () => {},
          );
        }
      }
    },
    [stopWaiting],
  );

  useEffect(() => {
    runAgainRef.current = run;
  }, [run]);

  /** A tap from the user: the automatic retries start fresh. */
  const begin = useCallback(
    (request: IngestRequest) => {
      streamRetriedRef.current = false;
      resumedRef.current = false;
      return run(request);
    },
    [run],
  );

  const startPdf = useCallback(
    (file: File) => begin({ kind: "pdf", file }),
    [begin],
  );
  const startSamplePdf = useCallback(
    (url: string, name: string) => begin({ kind: "pdf-sample", url, name }),
    [begin],
  );
  const startYoutube = useCallback(
    (url: string) => begin({ kind: "youtube", url }),
    [begin],
  );
  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    if (last) void begin(last);
  }, [begin]);
  const reset = useCallback(() => {
    cancel();
    lastRequestRef.current = null;
  }, [cancel]);

  /** "Keep waiting" on a slow upload: look again for progress in another while. */
  const keepWaiting = useCallback(() => {
    lastProgressRef.current = Date.now();
    dispatch({ type: "upload-resume" });
  }, []);

  // A link that stops moving is not an error, but the user should be told.
  const uploading = state.status === "uploading";
  useEffect(() => {
    if (!uploading) return;
    const id = setInterval(() => {
      if (Date.now() - lastProgressRef.current >= stallThresholdMs()) {
        dispatch({ type: "upload-stalled" });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [uploading]);

  // Leaving the screen stops the request, the stall check and any wait.
  useEffect(
    () => () => {
      waitRef.current?.abort();
      controllerRef.current?.abort();
    },
    [],
  );

  return {
    state,
    startPdf,
    startSamplePdf,
    startYoutube,
    retry,
    cancel,
    reset,
    keepWaiting,
  };
}

/** The bundled sample, fetched like any file: a deadline, and one more try. */
async function fetchSample(
  url: string,
  name: string,
  signal: AbortSignal,
): Promise<File> {
  const attempt = async () => {
    const deadline = withTimeout(signal, SAMPLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: deadline.signal });
      markReachable();
      if (!res.ok) throw new IngestError("upload_failed", "Sample missing");
      return await res.blob();
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof IngestError) throw error;
      markUnreachable();
      throw new IngestError("upload_failed", String(error), undefined, true);
    } finally {
      deadline.dispose();
    }
  };
  const blob = await retryOnce(attempt, {
    retryable: (e) => e instanceof IngestError && e.noAnswer,
    signal,
  });
  return new File([blob], name, { type: "application/pdf" });
}
