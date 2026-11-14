import "server-only";
import { z } from "zod";
import { getEnv, requireOpenAIKey } from "../env";
import { AppError, catalogError } from "../errors";

// Mints a short-lived Realtime client secret. Request shape: docs/reference/
// openai-realtime.md section 1 (GA names only). The adapter owns the timeout
// and the error mapping; nothing it throws carries the key, the instructions,
// the secret or OpenAI's own message text.

export const CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
export const CLIENT_SECRET_TTL_SECONDS = 60;
export const CLIENT_SECRET_TIMEOUT_MS = 10_000;
// Cheapest transcription model that works with VAD over WebRTC (reference §6).
export const TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

export interface MintedSecret {
  /** The ephemeral key. The only part of the response the browser gets. */
  value: string;
  /** Unix seconds, exactly as OpenAI reports it. */
  expiresAt: number;
  model: string;
}

export interface MintParams {
  instructions: string;
  /** Stable hash of the anonymous session cookie; binds to the secret. */
  safetyIdentifier: string;
}

export type OpenAIFailureKind =
  "budget" | "busy" | "rejected" | "unavailable" | "bad_response";

/** Typed so callers branch on `kind`, never on a message. */
export class OpenAIRequestError extends Error {
  constructor(
    readonly kind: OpenAIFailureKind,
    /** HTTP status when there was a response. */
    readonly status?: number,
    /** OpenAI's short error code, kept for server logs only. */
    readonly upstreamCode?: string,
  ) {
    super(
      `OpenAI client secret request failed: ${kind}${status ? ` (${status})` : ""}${upstreamCode ? ` [${upstreamCode}]` : ""}`,
    );
    this.name = "OpenAIRequestError";
  }
}

// Reference §3: branch on error.code. insufficient_quota is the one `type`
// that is unambiguous on its own.
const BILLING_CODES = new Set([
  "credit_balance_exhausted",
  "project_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
]);

const ErrorBodySchema = z.object({
  error: z
    .object({
      code: z.string().nullish(),
      type: z.string().nullish(),
    })
    .optional(),
});

const SuccessSchema = z.object({
  value: z.string().min(1),
  expires_at: z.number().int().positive(),
});

export function buildSessionRequest(
  params: MintParams,
  settings: {
    model: string;
    voice: string;
    reasoningEffort: "minimal" | "low" | "medium" | "high";
  },
) {
  return {
    // Sibling of `session`, not inside it.
    expires_after: {
      anchor: "created_at",
      seconds: CLIENT_SECRET_TTL_SECONDS,
    },
    session: {
      type: "realtime",
      model: settings.model,
      instructions: params.instructions,
      output_modalities: ["audio"],
      reasoning: { effort: settings.reasoningEffort },
      audio: {
        input: {
          transcription: { model: TRANSCRIPTION_MODEL },
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "auto",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: settings.voice },
      },
    },
  };
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    // Capped read: an error body is a few hundred bytes; never trust more.
    const text = (await res.text()).slice(0, 4096);
    const parsed = ErrorBodySchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    const { code, type } = parsed.data.error ?? {};
    if (code && BILLING_CODES.has(code)) return code;
    if (type === "insufficient_quota") return type;
    // Short and from a known alphabet, so it is safe in a log line.
    return code?.slice(0, 64).replace(/[^\w.-]/g, "");
  } catch {
    return undefined;
  }
}

async function classifyFailure(res: Response): Promise<OpenAIRequestError> {
  const code = await readErrorCode(res);
  if (code && BILLING_CODES.has(code)) {
    return new OpenAIRequestError("budget", res.status, code);
  }
  // Plain rate limits and overload clear up on their own; other 4xx mean our
  // request or key is wrong, which retrying will not fix.
  if (res.status === 429 || res.status >= 500) {
    return new OpenAIRequestError("busy", res.status, code);
  }
  return new OpenAIRequestError("rejected", res.status, code);
}

export async function createClientSecret(
  params: MintParams,
): Promise<MintedSecret> {
  const env = getEnv();
  const apiKey = requireOpenAIKey();
  const body = buildSessionRequest(params, {
    model: env.realtimeModel,
    voice: env.realtimeVoice,
    reasoningEffort: env.realtimeReasoningEffort,
  });

  let res: Response;
  try {
    res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "openai-safety-identifier": params.safetyIdentifier,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLIENT_SECRET_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // Timeout, DNS or TLS failure. The underlying error is dropped on purpose.
    throw new OpenAIRequestError("unavailable");
  }

  if (!res.ok) throw await classifyFailure(res);

  let parsed: z.infer<typeof SuccessSchema>;
  try {
    parsed = SuccessSchema.parse(await res.json());
  } catch {
    throw new OpenAIRequestError("bad_response", res.status);
  }
  return {
    value: parsed.value,
    expiresAt: parsed.expires_at,
    model: env.realtimeModel,
  };
}

/** What the browser is told. Details stay in the server log via `cause`. */
export function toSessionError(err: OpenAIRequestError): AppError {
  switch (err.kind) {
    case "budget":
      return catalogError("budget_exhausted", { cause: err });
    case "busy":
      return catalogError("session_upstream_busy", { cause: err });
    case "rejected":
    case "unavailable":
    case "bad_response":
      return catalogError("session_connect_failed", { cause: err });
    default: {
      const unreachable: never = err.kind;
      return unreachable;
    }
  }
}
