import { ERROR_CATALOG } from "@/lib/errors/catalog";
import {
  ErrorBodySchema,
  SessionResponseSchema,
  type SessionResponse,
} from "@/lib/wire/session";
import type { FailureCode } from "./failure";

// Asks our server for a Realtime client secret. Only the document id goes
// up; the server builds the instructions itself, so the browser cannot
// influence them (SPEC section 6).

export class MintError extends Error {
  constructor(
    readonly code: FailureCode,
    /** From the Retry-After header of a 429; lets the UI say when to try again. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`Could not start a session: ${code}`);
    this.name = "MintError";
  }
}

const MAX_RETRY_AFTER_SECONDS = 3600;

/** Seconds from a Retry-After header, or undefined if it is missing or unusable. */
export function parseRetryAfter(value: string | null): number | undefined {
  const seconds = Number(value);
  if (value === null || value.trim() === "") return undefined;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  // Whole seconds, and never an absurd wait if a proxy sends nonsense.
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
}

export async function mintSession(
  documentId: string,
  signal: AbortSignal,
  doFetch: typeof fetch = fetch,
): Promise<SessionResponse> {
  let res: Response;
  try {
    res = await doFetch("/api/realtime/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId }),
      cache: "no-store",
      signal,
    });
  } catch (err) {
    // An abort is the caller's own doing; let it through unchanged.
    if (signal.aborted) throw err;
    throw new MintError("session_connect_failed");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new MintError(res.ok ? "session_connect_failed" : "internal");
  }

  if (!res.ok) {
    // Only codes we know copy for; anything else is shown as a generic failure.
    const parsed = ErrorBodySchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : null;
    throw new MintError(
      code !== null && code in ERROR_CATALOG
        ? (code as FailureCode)
        : "session_connect_failed",
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  const ok = SessionResponseSchema.safeParse(body);
  if (!ok.success) throw new MintError("session_connect_failed");
  return ok.data;
}
