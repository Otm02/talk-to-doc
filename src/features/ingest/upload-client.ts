import { upload } from "@vercel/blob/client";
import { markReachable, markUnreachable } from "@/lib/net/connectivity";
import { retryOnce } from "@/lib/net/retry";
import { abortError, withTimeout } from "@/lib/net/timeout";
import { IngestError, StreamBrokenError } from "./ingest-error";

/** How long to wait for a server's first answer, per call. */
export const HEALTH_TIMEOUT_MS = 10_000;
export const YOUTUBE_TIMEOUT_MS = 45_000;
/** The PDF is read before the first page goes out, so this is generous. */
export const PDF_ANSWER_TIMEOUT_MS = 60_000;

/**
 * fetch with a deadline for the first answer. A response of any kind marks the
 * server reachable (a refusal is an answer); no response marks it unreachable
 * and raises a "no answer" IngestError that is safe to wait out and repeat.
 */
async function fetchWithin(
  url: string,
  init: RequestInit,
  ms: number,
  signal: AbortSignal | undefined,
  code: string,
): Promise<Response> {
  const deadline = withTimeout(signal, ms);
  try {
    const res = await fetch(url, { ...init, signal: deadline.signal });
    markReachable();
    // The deadline was for the first byte. Stop the clock, but keep following
    // the caller's abort: the body is still coming, and Cancel must stop it.
    deadline.disarm();
    return res;
  } catch (error) {
    deadline.dispose();
    // The caller's own abort is not a failure to report.
    if (signal?.aborted) throw abortError();
    markUnreachable();
    throw new IngestError(
      code,
      deadline.timedOut() ? "Timed out" : String(error),
      undefined,
      true,
    );
  }
}

/** Only a call that got no answer, or a 502 from the provider chain, is worth one more try. */
function retryableYoutube(error: unknown): boolean {
  return (
    error instanceof IngestError &&
    (error.noAnswer || error.code === "youtube_failed")
  );
}

export type UploadMode = "direct" | "blob";

export interface IngestCallbacks {
  /** 0–100 while the file travels to the server or to Blob. */
  onUploadProgress?: (percent: number) => void;
  /** The file has arrived; the server is reading it now. */
  onUploaded?: () => void;
}

let uploadModePromise: Promise<UploadMode> | null = null;

/** The server decides the mode (UPLOAD_MODE); /api/health reports it. */
export function getUploadMode(signal?: AbortSignal): Promise<UploadMode> {
  uploadModePromise ??= retryOnce(
    async () => {
      const res = await fetchWithin(
        "/api/health",
        { cache: "no-store" },
        HEALTH_TIMEOUT_MS,
        signal,
        "upload_failed",
      );
      const body: unknown = await res.json().catch(() => null);
      const mode =
        typeof body === "object" && body !== null && "uploadMode" in body
          ? body.uploadMode
          : null;
      if (mode !== "blob" && mode !== "direct") {
        throw new IngestError("upload_failed", "bad health");
      }
      return mode;
    },
    { retryable: (e) => e instanceof IngestError, signal },
  ).catch((error: unknown) => {
    // Don't cache a failure: the next try should ask again.
    uploadModePromise = null;
    throw error instanceof IngestError
      ? error
      : new IngestError("upload_failed", String(error));
  });
  return uploadModePromise;
}

/** Test hook: forget the cached mode. */
export function resetUploadModeForTests(): void {
  uploadModePromise = null;
}

/** Blob only accepts `uploads/<safe name>.pdf`; see UPLOAD_PATHNAME on the server. */
export function blobPathname(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "");
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `uploads/${(safe || "document").slice(0, 90)}.pdf`;
}

function codeFromBody(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return "internal";
  }
  const { error } = body;
  if (typeof error === "object" && error !== null && "code" in error) {
    if (typeof error.code === "string") return error.code;
  }
  return "internal";
}

const MAX_BODY_WAIT_SEC = 86_400;
const MAX_HEADER_WAIT_SEC = 3_600;

/**
 * How long a 429 asks us to wait: `error.retryAfterSec` in the body, or the
 * Retry-After header when a proxy answered instead of our route.
 */
export function retryAfter(
  body: unknown,
  header: string | null,
): number | undefined {
  let fromBody: unknown;
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body;
    if (
      typeof error === "object" &&
      error !== null &&
      "retryAfterSec" in error
    ) {
      fromBody = error.retryAfterSec;
    }
  }
  // Same ceilings as the session mint: a bad header must not park the retry
  // button for days.
  const candidates: Array<[unknown, number]> = [
    [fromBody, MAX_BODY_WAIT_SEC],
    [
      header === null || header.trim() === "" ? undefined : Number(header),
      MAX_HEADER_WAIT_SEC,
    ],
  ];
  for (const [raw, cap] of candidates) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.min(Math.ceil(raw), cap);
    }
  }
  return undefined;
}

async function errorFromResponse(res: Response): Promise<IngestError> {
  const body: unknown = await res.json().catch(() => null);
  return new IngestError(
    codeFromBody(body),
    `HTTP ${res.status}`,
    retryAfter(body, res.headers.get("retry-after")),
  );
}

/**
 * Direct mode. fetch can't report upload progress, so this uses XHR. The
 * response body is exposed as a stream by slicing `responseText` as chunks
 * arrive, which keeps page-by-page rendering.
 */
function postFormWithProgress(
  url: string,
  form: FormData,
  signal: AbortSignal,
  callbacks: IngestCallbacks,
): Promise<ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let sent = 0;
    let streaming = false;
    let timedOut = false;
    // Once the whole file is up, the server must start answering.
    let answerTimer: ReturnType<typeof setTimeout> | undefined;

    const pump = () => {
      if (!controller) return;
      const text = xhr.responseText;
      if (text.length > sent) {
        controller.enqueue(encoder.encode(text.slice(sent)));
        sent = text.length;
      }
    };
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(answerTimer);
      signal.removeEventListener("abort", onAbort);
    };

    xhr.open("POST", url);
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        callbacks.onUploadProgress?.(
          Math.min(100, Math.round((event.loaded / event.total) * 100)),
        );
      }
    };
    xhr.upload.onload = () => {
      callbacks.onUploaded?.();
      answerTimer = setTimeout(() => {
        timedOut = true;
        xhr.abort();
      }, PDF_ANSWER_TIMEOUT_MS);
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.HEADERS_RECEIVED) return;
      clearTimeout(answerTimer);
      markReachable();
      if (xhr.status < 200 || xhr.status >= 300) return; // handled in onload
      streaming = true;
      resolve(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
          cancel() {
            xhr.abort();
          },
        }),
      );
    };
    xhr.onprogress = pump;
    xhr.onload = () => {
      cleanup();
      if (streaming) {
        pump();
        controller?.close();
        return;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (a proxy page, say): keep the generic code.
      }
      reject(
        new IngestError(
          codeFromBody(body),
          `HTTP ${xhr.status}`,
          retryAfter(body, xhr.getResponseHeader("retry-after")),
        ),
      );
    };
    xhr.onerror = () => {
      cleanup();
      if (streaming) {
        // The server was answering, so this is a stream that broke, not a
        // request nobody answered: the pages already read stay, and nothing
        // claims the device is offline.
        controller?.error(
          new StreamBrokenError("upload_failed", "Stream broke"),
        );
        return;
      }
      markUnreachable();
      reject(
        new IngestError("upload_failed", "Network error", undefined, true),
      );
    };
    xhr.onabort = () => {
      cleanup();
      if (timedOut) {
        // Our own answer timer: the file went up and nothing came back.
        markUnreachable();
        reject(new IngestError("upload_failed", "Timed out", undefined, true));
        return;
      }
      // The caller cancelling.
      if (streaming) controller?.error(abortError());
      else reject(abortError());
    };
    xhr.send(form);
  });
}

/** Opens the ingest stream for a PDF, by whichever upload mode the server uses. */
export async function ingestPdf(
  file: File,
  mode: UploadMode,
  signal: AbortSignal,
  callbacks: IngestCallbacks = {},
): Promise<ReadableStream<Uint8Array>> {
  if (mode === "direct") {
    const form = new FormData();
    form.append("file", file, file.name);
    return postFormWithProgress("/api/ingest/pdf", form, signal, callbacks);
  }

  let blobUrl: string;
  try {
    const blob = await upload(blobPathname(file.name), file, {
      access: "private",
      handleUploadUrl: "/api/upload/token",
      abortSignal: signal,
      onUploadProgress: ({ percentage }) =>
        callbacks.onUploadProgress?.(Math.round(percentage)),
    });
    blobUrl = blob.url;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw new IngestError("upload_failed", String(error));
  }
  callbacks.onUploaded?.();

  // Not repeated on its own: the blob is deleted as soon as it is read.
  const res = await fetchWithin(
    "/api/ingest/pdf",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blobUrl, fileName: file.name }),
    },
    PDF_ANSWER_TIMEOUT_MS,
    signal,
    "upload_failed",
  );
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  return res.body;
}

/**
 * Opens the ingest stream for a YouTube link. Safe to repeat (the server
 * caches the transcript), so a call that got no answer, or a 502, is tried
 * once more by itself.
 */
export async function ingestYoutube(
  url: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const lang =
    typeof navigator === "undefined" ? undefined : navigator.language;
  return retryOnce(
    async () => {
      const res = await fetchWithin(
        "/api/ingest/youtube",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, ...(lang ? { lang } : {}) }),
        },
        YOUTUBE_TIMEOUT_MS,
        signal,
        "youtube_failed",
      );
      if (!res.ok || !res.body) throw await errorFromResponse(res);
      return res.body;
    },
    { retryable: retryableYoutube, signal },
  );
}
