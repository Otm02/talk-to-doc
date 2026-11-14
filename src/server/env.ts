import "server-only";
import { z } from "zod";

// The only place that reads process.env. Validation is lazy (first call) so
// `next build` and CI run without secrets.

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const optional = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined || v.trim() === "" ? undefined : v.trim(),
  );

const intInRange = (min: number, max: number, fallback: number) =>
  optional.pipe(
    z
      .string()
      .regex(/^\d+$/, "must be a whole number")
      .transform(Number)
      .pipe(z.number().min(min).max(max))
      .optional()
      .transform((v) => v ?? fallback),
  );

const MODELS = ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"] as const;

const schema = z.object({
  OPENAI_API_KEY: optional,
  SUPADATA_API_KEY: optional,
  REALTIME_MODEL: optional.pipe(
    z
      .enum(MODELS)
      .optional()
      .transform((v) => v ?? "gpt-realtime-2.1-mini"),
  ),
  REALTIME_VOICE: optional.pipe(
    z
      .string()
      .optional()
      .transform((v) => v ?? "marin"),
  ),
  REALTIME_REASONING_EFFORT: optional.pipe(
    z
      .enum(["minimal", "low", "medium", "high"])
      .optional()
      .transform((v) => v ?? "low"),
  ),
  CONTEXT_TOKEN_BUDGET: intInRange(1000, 60000, 8000),
  MAX_SESSION_MINUTES: intInRange(1, 30, 5),
  DOC_TTL_MINUTES: intInRange(1, 1440, 120),
  UPLOAD_MODE: optional.pipe(z.enum(["direct", "blob"]).optional()),
  VOICE_ENABLED: optional.pipe(bool.optional().transform((v) => v ?? true)),
  DAILY_SESSION_CAP: intInRange(0, 10000, 40),
  BLOB_READ_WRITE_TOKEN: optional,
  UPSTASH_REDIS_REST_URL: optional,
  UPSTASH_REDIS_REST_TOKEN: optional,
  KV_REST_API_URL: optional,
  KV_REST_API_TOKEN: optional,
  VERCEL: optional,
  VERCEL_ENV: optional,
  VERCEL_GIT_COMMIT_SHA: optional,
});

export type StateDriver = "memory" | "upstash";
export type UploadMode = "direct" | "blob";

export interface Env {
  openaiApiKey: string | undefined;
  supadataApiKey: string | undefined;
  realtimeModel: (typeof MODELS)[number];
  realtimeVoice: string;
  realtimeReasoningEffort: "minimal" | "low" | "medium" | "high";
  contextTokenBudget: number;
  maxSessionMinutes: number;
  docTtlMinutes: number;
  uploadMode: UploadMode;
  voiceEnabled: boolean;
  dailySessionCap: number;
  blobToken: string | undefined;
  upstash: { url: string; token: string } | undefined;
  stateDriver: StateDriver;
  onVercel: boolean;
  commitSha: string | undefined;
}

export class EnvError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\nSee .env.example.`,
    );
    this.name = "EnvError";
    this.problems = problems;
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Issue messages name the variable and the rule, never the value.
    throw new EnvError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const v = parsed.data;
  const onVercel = v.VERCEL !== undefined || v.VERCEL_ENV !== undefined;
  const uploadMode: UploadMode =
    v.UPLOAD_MODE ?? (onVercel ? "blob" : "direct");

  const upstashUrl = v.UPSTASH_REDIS_REST_URL ?? v.KV_REST_API_URL;
  const upstashToken = v.UPSTASH_REDIS_REST_TOKEN ?? v.KV_REST_API_TOKEN;
  const upstash =
    upstashUrl && upstashToken
      ? { url: upstashUrl, token: upstashToken }
      : undefined;

  const problems: string[] = [];
  if (Boolean(upstashUrl) !== Boolean(upstashToken)) {
    problems.push(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together",
    );
  }
  // Serverless instances do not share memory, so these modes only work locally.
  if (onVercel && uploadMode === "direct") {
    problems.push(
      "UPLOAD_MODE=direct is not allowed on Vercel (4.5 MB body cap)",
    );
  }
  if (onVercel && !upstash) {
    problems.push(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required on Vercel (in-memory state is not shared)",
    );
  }
  if (problems.length > 0) throw new EnvError(problems);

  return {
    openaiApiKey: v.OPENAI_API_KEY,
    supadataApiKey: v.SUPADATA_API_KEY,
    realtimeModel: v.REALTIME_MODEL,
    realtimeVoice: v.REALTIME_VOICE,
    realtimeReasoningEffort: v.REALTIME_REASONING_EFFORT,
    contextTokenBudget: v.CONTEXT_TOKEN_BUDGET,
    maxSessionMinutes: v.MAX_SESSION_MINUTES,
    docTtlMinutes: v.DOC_TTL_MINUTES,
    uploadMode,
    voiceEnabled: v.VOICE_ENABLED,
    dailySessionCap: v.DAILY_SESSION_CAP,
    blobToken: v.BLOB_READ_WRITE_TOKEN,
    upstash,
    stateDriver: upstash ? "upstash" : "memory",
    onVercel,
    commitSha: v.VERCEL_GIT_COMMIT_SHA,
  };
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Lazy so only code that calls OpenAI needs the key. */
export function requireOpenAIKey(): string {
  const key = getEnv().openaiApiKey;
  if (!key)
    throw new EnvError(["OPENAI_API_KEY is required for live sessions"]);
  return key;
}

export function resetEnvCacheForTests(): void {
  cached = undefined;
}
