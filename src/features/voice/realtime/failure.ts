import { ERROR_CATALOG, type CatalogCode } from "@/lib/errors/catalog";

// Client-side codes and copy from docs/SPEC.md section 4.2. They never travel
// over the wire, so they stay out of the shared catalog. Server codes keep
// their catalog copy.

const CLIENT_COPY = {
  mic_denied:
    "Microphone access is off. You can type instead, or allow the mic in your browser settings.",
  mic_not_found: "No microphone found. You can type your questions instead.",
  mic_in_use:
    "Your microphone is busy in another app. Close it and try again, or type instead.",
  // Not in SPEC 4.2: an insecure page or a browser without getUserMedia.
  mic_unavailable:
    "The microphone isn't available here. You can type your questions instead.",
  session_reconnect_failed:
    "Connection lost. Check your network and try again.",
  // A request never reached a server (as opposed to a server saying no).
  session_network_failed:
    "You're offline or the network dropped. Check your connection and try again.",
} as const;

export type ClientFailureCode = keyof typeof CLIENT_COPY;
export type FailureCode = CatalogCode | ClientFailureCode;

export function failureMessage(code: FailureCode): string {
  return code in CLIENT_COPY
    ? CLIENT_COPY[code as ClientFailureCode]
    : ERROR_CATALOG[code as CatalogCode].message;
}

export function isFailureCode(code: string): code is FailureCode {
  return code in CLIENT_COPY || code in ERROR_CATALOG;
}

/** Why getUserMedia gave us nothing. The UI turns these into text mode. */
export type MicFailure =
  | "denied"
  | "not_found"
  | "in_use"
  | "insecure"
  | "unsupported"
  | "unavailable";

export function micFailureCode(reason: MicFailure): ClientFailureCode {
  switch (reason) {
    case "denied":
      return "mic_denied";
    case "not_found":
      return "mic_not_found";
    case "in_use":
      return "mic_in_use";
    case "insecure":
    case "unsupported":
    case "unavailable":
      return "mic_unavailable";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/** Why a chat ended on purpose, as opposed to failing. */
export type EndReason = "user" | "max_duration" | "idle" | "hidden";

export function endReasonMessage(
  reason: EndReason,
  maxMinutes: number,
): string | null {
  switch (reason) {
    case "user":
      return null;
    // SPEC 4.2 says "10-minute"; the real cap is MAX_SESSION_MINUTES.
    case "max_duration":
      return `This chat reached its ${maxMinutes}-minute limit. Start a new one to keep going.`;
    case "idle":
      return "Chat ended after 2 minutes of silence. Start again when you're ready.";
    case "hidden":
      return "Chat ended because the app was in the background.";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

// Mirrors BILLING_CODES in src/server/realtime/createClientSecret.ts, which
// is server-only and cannot be imported here. Retrying never helps.
const BILLING_CODES: ReadonlySet<string> = new Set([
  "credit_balance_exhausted",
  "project_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

export function isBillingCode(code: string | null | undefined): boolean {
  return code != null && BILLING_CODES.has(code);
}
