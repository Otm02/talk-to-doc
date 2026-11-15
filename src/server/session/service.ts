import "server-only";
import { z } from "zod";
import { countTokens } from "../context/budget";
import {
  MAX_TURN_CHARS,
  buildInstructions,
} from "../context/buildInstructions";
import type { SessionResponse } from "@/lib/wire/session";
import { getEnv } from "../env";
import { catalogError } from "../errors";
import { parseWith } from "../http";
import { ReadFailure, readJsonBody } from "./body";
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
 * day's sessions.
 */
export async function createSession(
  req: Request,
  requestId: string,
): Promise<Response> {
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

  const body = parseWith(SessionBodySchema, await readBody(req));
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

  // A concurrent request may have taken the last slot meanwhile. The secret
  // is already minted and minting costs nothing, so the count is still taken.
  await rateLimiter.countDaily(DAILY_SESSION_KEY, env.dailySessionCap);

  // Ids, sizes and the model only. Never the document, instructions or secret.
  console.info(
    JSON.stringify({
      event: "session_minted",
      requestId,
      documentId: body.documentId,
      source: doc.source,
      model: secret.model,
      instructionTokens: countTokens(instructions),
      historyTurns: body.history?.length ?? 0,
    }),
  );

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

async function readBody(req: Request): Promise<unknown> {
  try {
    return await readJsonBody(req, MAX_SESSION_BODY_BYTES);
  } catch (err) {
    if (err instanceof ReadFailure) throw catalogError("invalid_request");
    throw err;
  }
}
