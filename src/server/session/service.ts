import "server-only";
import { z } from "zod";
import {
  MAX_TURN_CHARS,
  buildInstructions,
} from "../context/buildInstructions";
import type { SessionResponse } from "@/lib/wire/session";
import { getEnv } from "../env";
import { catalogError } from "../errors";
import { parseJsonBody } from "../body";
import {
  OpenAIRequestError,
  createClientSecret,
  type MintedSecret,
  toSessionError,
} from "../realtime/createClientSecret";
import { enforceRateLimit } from "../security/rate-limit";
import { getState } from "../state";
import { secondsUntilNextUtcDay } from "../state/types";
import { loadInstructionDocument } from "./document";
import {
  getAnonymousIdentity,
  safetyIdentifier,
  sessionCookieHeader,
} from "./identity";
import {
  DAILY_SESSION_KEY,
  MAX_HISTORY_TURNS,
  MAX_SESSION_BODY_BYTES,
  SESSION_IP_RATE,
} from "./limits";

export const SessionBodySchema = z.strictObject({
  documentId: z.uuid(),
  history: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(MAX_TURN_CHARS),
      }),
    )
    .max(MAX_HISTORY_TURNS)
    .optional(),
});

/**
 * POST /api/realtime/session. Gates run before anything is read or paid for:
 * kill switch, per-IP limit, daily cap. The daily counter is only bumped
 * after OpenAI has handed back a secret, so failed attempts never use up the
 * day's sessions; the bump itself is what enforces the cap under concurrency.
 */
export async function createSession(req: Request): Promise<Response> {
  const env = getEnv();
  const { rateLimiter } = getState();

  if (!env.voiceEnabled) throw catalogError("voice_disabled");
  await enforceRateLimit(req, "session", SESSION_IP_RATE);
  if ((await rateLimiter.peekDaily(DAILY_SESSION_KEY)) >= env.dailySessionCap) {
    // The counter is keyed by UTC date, so that is when it frees up.
    throw catalogError("daily_limit", {
      retryAfterSeconds: secondsUntilNextUtcDay(Date.now()),
    });
  }

  const body = await parseJsonBody(
    req,
    SessionBodySchema,
    MAX_SESSION_BODY_BYTES,
  );
  const doc = await loadInstructionDocument(body.documentId);
  const instructions = buildInstructions(doc, body.history);

  const identity = getAnonymousIdentity(req);
  let secret: MintedSecret;
  try {
    secret = await createClientSecret({
      instructions,
      safetyIdentifier: safetyIdentifier(identity),
    });
  } catch (err) {
    if (err instanceof OpenAIRequestError) throw toSessionError(err);
    throw err;
  }

  // The check at the top is only a cheap early refusal: requests that arrive
  // together all pass it. This count is atomic, so it decides who really gets
  // the last slot. The loser's secret is never handed out and expires in 60 s.
  const counted = await rateLimiter.countDaily(
    DAILY_SESSION_KEY,
    env.dailySessionCap,
  );
  if (!counted.allowed) {
    throw catalogError("daily_limit", {
      retryAfterSeconds: secondsUntilNextUtcDay(Date.now()),
    });
  }

  const response: SessionResponse = {
    clientSecret: secret.value,
    expiresAt: secret.expiresAt,
    model: secret.model,
    maxSessionSeconds: env.maxSessionMinutes * 60,
  };
  const headers = new Headers({ "cache-control": "no-store" });
  if (identity.isNew) {
    headers.append(
      "set-cookie",
      sessionCookieHeader(identity, new URL(req.url).protocol === "https:"),
    );
  }
  return Response.json(response, { headers });
}
