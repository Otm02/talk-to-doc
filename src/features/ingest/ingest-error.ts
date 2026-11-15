/** An ingestion failure with a wire code, raised by the upload client and reader. */
export class IngestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    /**
     * The request got no response at all (the network, not a refusal). Only
     * these are worth waiting out and repeating when the connection returns.
     */
    readonly noAnswer: boolean = false,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/**
 * The stream of pages ended early or went quiet: what was received is still
 * good, and the load can be tried again. Distinct from an error the server
 * sent on purpose (a `{ error }` line), where nothing is worth keeping.
 *
 * Not a "no answer": the server did answer, and a server that dies mid-stream
 * on a healthy network must not make the app claim it is offline.
 */
export class StreamBrokenError extends IngestError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StreamBrokenError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
