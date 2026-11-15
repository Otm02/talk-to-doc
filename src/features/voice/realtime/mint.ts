import { ERROR_CATALOG } from "@/lib/errors/catalog";
import { markReachable, markUnreachable } from "@/lib/net/connectivity";
import { withTimeout } from "@/lib/net/timeout";
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
    /** From a 429 (body first, Retry-After header second): lets the UI count down. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`Could not start a session: ${code}`);
    this.name = "MintError";
  }
}

const MAX_RETRY_AFTER_SECONDS = 3600;

// The daily cap resets at UTC midnight, so its wait can be most of a day.
const MAX_BODY_RETRY_AFTER_SECONDS = 24 * 60 * 60;

function clampWait(seconds: number, max: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  // Whole seconds, and never an absurd wait if something sends nonsense.
  return Math.min(Math.ceil(seconds), max);
}

/** Seconds from a Retry-After header, or undefined if it is missing or unusable. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  return clampWait(Number(value), MAX_RETRY_AFTER_SECONDS);
}

/**
 * The wait a refusal carries. Our own body field wins (it is always there on a
 * 429 and survives proxies that drop headers); the header is the fallback.
 */
export function retryAfterFrom(
  bodySeconds: number | undefined,
  header: string | null,
): number | undefined {
  return (
    (bodySeconds === undefined
      ? undefined
      : clampWait(bodySeconds, MAX_BODY_RETRY_AFTER_SECONDS)) ??
    parseRetryAfter(header)
  );
}

/** One earlier turn, sent so a replacement session can pick the talk up again. */
export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

// Mirror MAX_HISTORY_TURNS and MAX_TURN_CHARS in src/server, which is
// server-only and cannot be imported here. The route rejects anything longer,
// so the newest turns are kept and each is cut to fit.
export const MAX_HISTORY_TURNS = 30;
export const MAX_HISTORY_TURN_CHARS = 4000;

export function clampHistory(turns: readonly HistoryTurn[]): HistoryTurn[] {
  return turns
    .filter((t) => t.text.trim() !== "")
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({
      role: t.role,
      text: t.text.slice(0, MAX_HISTORY_TURN_CHARS),
    }));
}

/** A mint that has not answered by now is treated as no answer at all. */
export const MINT_TIMEOUT_MS = 15_000;

export async function mintSession(
  documentId: string,
  signal: AbortSignal,
  doFetch: typeof fetch = fetch,
  history: readonly HistoryTurn[] = [],
): Promise<SessionResponse> {
  const turns = clampHistory(history);
  const deadline = withTimeout(signal, MINT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch("/api/realtime/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        turns.length > 0 ? { documentId, history: turns } : { documentId },
      ),
      cache: "no-store",
      signal: deadline.signal,
    });
  } catch (err) {
    // An abort is the caller's own doing; let it through unchanged.
    deadline.dispose();
    if (signal.aborted) throw err;
    // The deadline passing is not "nothing happened": the server may have
    // minted a secret and counted it while we stopped listening. Saying so as
    // "offline" would also send the first-start flow to mint again, which is a
    // second secret for one chat. It is a failure the user retries.
    if (deadline.timedOut()) throw new MintError("session_connect_failed");
    // fetch threw before any response came back: that is the network, not a
    // refusal, nothing was created, and the UI says "Offline".
    markUnreachable();
    throw new MintError("session_network_failed");
  }
  // Any answer, even a refusal, proves the server can be reached.
  markReachable();

  // The deadline stays armed while the body streams in.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    // The server answered, so this is not offline. A body that stalled after
    // a 200 may still have cost a secret: no automatic second mint.
    throw new MintError(
      res.ok || deadline.timedOut() ? "session_connect_failed" : "internal",
    );
  } finally {
    deadline.dispose();
  }

  if (!res.ok) {
    // Only codes we know copy for; anything else is shown as a generic failure.
    const parsed = ErrorBodySchema.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : null;
    throw new MintError(
      code !== null && code in ERROR_CATALOG
        ? (code as FailureCode)
        : "session_connect_failed",
      retryAfterFrom(
        parsed.success ? parsed.data.error.retryAfterSec : undefined,
        res.headers.get("retry-after"),
      ),
    );
  }
  const ok = SessionResponseSchema.safeParse(body);
  if (!ok.success) throw new MintError("session_connect_failed");
  return ok.data;
}
