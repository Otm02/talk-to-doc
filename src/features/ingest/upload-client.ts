import { upload } from "@vercel/blob/client";
import { IngestError } from "./ingest-error";

export type UploadMode = "direct" | "blob";

export interface IngestCallbacks {
  /** 0–100 while the file travels to the server or to Blob. */
  onUploadProgress?: (percent: number) => void;
  /** The file has arrived; the server is reading it now. */
  onUploaded?: () => void;
}

let uploadModePromise: Promise<UploadMode> | null = null;

/** The server decides the mode (UPLOAD_MODE); /api/health reports it. */
export function getUploadMode(): Promise<UploadMode> {
  uploadModePromise ??= fetch("/api/health", { cache: "no-store" })
    .then(async (res) => {
      const body: unknown = await res.json();
      const mode =
        typeof body === "object" && body !== null && "uploadMode" in body
          ? body.uploadMode
          : null;
      if (mode !== "blob" && mode !== "direct") throw new Error("bad health");
      return mode;
    })
    .catch((error: unknown) => {
      // Don't cache a failure: the next try should ask again.
      uploadModePromise = null;
      throw new IngestError("upload_failed", String(error));
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

function retryAfter(value: string | null): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

async function errorFromResponse(res: Response): Promise<IngestError> {
  const body: unknown = await res.json().catch(() => null);
  return new IngestError(
    codeFromBody(body),
    `HTTP ${res.status}`,
    retryAfter(res.headers.get("retry-after")),
  );
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
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
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    xhr.open("POST", url);
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        callbacks.onUploadProgress?.(
          Math.min(100, Math.round((event.loaded / event.total) * 100)),
        );
      }
    };
    xhr.upload.onload = () => callbacks.onUploaded?.();
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== XMLHttpRequest.HEADERS_RECEIVED) return;
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
          retryAfter(xhr.getResponseHeader("retry-after")),
        ),
      );
    };
    xhr.onerror = () => {
      cleanup();
      const error = new IngestError("upload_failed", "Network error");
      if (streaming) controller?.error(error);
      else reject(error);
    };
    xhr.onabort = () => {
      cleanup();
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

  const res = await fetch("/api/ingest/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blobUrl, fileName: file.name }),
    signal,
  }).catch((error: unknown) => {
    if (signal.aborted) throw abortError();
    throw new IngestError("upload_failed", String(error));
  });
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  return res.body;
}

/** Opens the ingest stream for a YouTube link. */
export async function ingestYoutube(
  url: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const lang = typeof navigator === "undefined" ? undefined : navigator.language;
  const res = await fetch("/api/ingest/youtube", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, ...(lang ? { lang } : {}) }),
    signal,
  }).catch((error: unknown) => {
    if (signal.aborted) throw abortError();
    throw new IngestError("youtube_failed", String(error));
  });
  if (!res.ok || !res.body) throw await errorFromResponse(res);
  return res.body;
}
