import "server-only";
import { createHash } from "node:crypto";

// An anonymous, random, long-lived id in a cookie. It is never linked to
// anything else; its only job is to give OpenAI's abuse systems a stable
// identifier per browser (the OpenAI-Safety-Identifier header), so one abusive
// visitor cannot get the whole key flagged.

export const SESSION_COOKIE = "ttd_sid";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const COOKIE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AnonymousIdentity {
  id: string;
  /** True when the browser did not send a usable cookie and we made one. */
  isNew: boolean;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function getAnonymousIdentity(req: Request): AnonymousIdentity {
  const existing = readCookie(req, SESSION_COOKIE);
  // Only our own format is accepted, so a forged cookie cannot choose an
  // arbitrary identifier or put odd characters into a header.
  if (existing && COOKIE_ID.test(existing)) {
    return { id: existing, isNew: false };
  }
  return { id: crypto.randomUUID(), isNew: true };
}

/** 64 hex characters: within OpenAI's identifier length limit, and reveals nothing. */
export function safetyIdentifier(identity: AnonymousIdentity): string {
  return createHash("sha256").update(`ttd-safety:${identity.id}`).digest("hex");
}

export function sessionCookieHeader(
  identity: AnonymousIdentity,
  secure: boolean,
): string {
  return [
    `${SESSION_COOKIE}=${identity.id}`,
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
