import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env";

const upstash = {
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "super-secret-token",
};

describe("parseEnv", () => {
  it("applies defaults with no variables at all", () => {
    const env = parseEnv({});
    expect(env.realtimeModel).toBe("gpt-realtime-2.1-mini");
    expect(env.realtimeReasoningEffort).toBe("low");
    expect(env.contextTokenBudget).toBe(8000);
    expect(env.maxSessionMinutes).toBe(5);
    expect(env.docTtlMinutes).toBe(120);
    expect(env.voiceEnabled).toBe(true);
    expect(env.dailySessionCap).toBe(40);
    expect(env.dailySpendLimitUsd).toBe(3);
    expect(env.uploadMode).toBe("direct");
    expect(env.stateDriver).toBe("memory");
    expect(env.openaiApiKey).toBeUndefined();
  });

  it("treats empty strings as unset", () => {
    expect(
      parseEnv({ REALTIME_MODEL: "", ADMIN_TOKEN: "  " }).adminToken,
    ).toBeUndefined();
  });

  it("rejects an unknown model", () => {
    expect(() => parseEnv({ REALTIME_MODEL: "gpt-4" })).toThrow(EnvError);
  });

  it("rejects out-of-range and non-numeric numbers", () => {
    expect(() => parseEnv({ CONTEXT_TOKEN_BUDGET: "10" })).toThrow(
      /CONTEXT_TOKEN_BUDGET/,
    );
    expect(() => parseEnv({ MAX_SESSION_MINUTES: "abc" })).toThrow(
      /MAX_SESSION_MINUTES/,
    );
  });

  it("parses VOICE_ENABLED=false and a decimal spend limit", () => {
    const env = parseEnv({
      VOICE_ENABLED: "false",
      DAILY_SPEND_LIMIT_USD: "1.5",
    });
    expect(env.voiceEnabled).toBe(false);
    expect(env.dailySpendLimitUsd).toBe(1.5);
  });

  it("picks upstash when its variables exist, under either name", () => {
    expect(parseEnv(upstash).stateDriver).toBe("upstash");
    const kv = parseEnv({
      KV_REST_API_URL: "https://x.upstash.io",
      KV_REST_API_TOKEN: "t",
    });
    expect(kv.upstash?.url).toBe("https://x.upstash.io");
  });

  it("rejects half-configured upstash", () => {
    expect(() =>
      parseEnv({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }),
    ).toThrow(/set together/);
  });

  it("defaults to blob on Vercel and requires upstash there", () => {
    expect(parseEnv({ VERCEL_ENV: "preview", ...upstash }).uploadMode).toBe(
      "blob",
    );
    expect(() => parseEnv({ VERCEL_ENV: "preview" })).toThrow(
      /required on Vercel/,
    );
  });

  it("refuses UPLOAD_MODE=direct on Vercel", () => {
    expect(() =>
      parseEnv({ VERCEL_ENV: "production", UPLOAD_MODE: "direct", ...upstash }),
    ).toThrow(/not allowed on Vercel/);
  });

  it("never puts secret values in error text", () => {
    const secrets = {
      OPENAI_API_KEY: "sk-live-abc123",
      ADMIN_TOKEN: "admin-secret-xyz",
      UPSTASH_REDIS_REST_TOKEN: "super-secret-token",
      REALTIME_MODEL: "bad-model-sk-leak",
      VERCEL_ENV: "preview",
    };
    try {
      parseEnv(secrets);
      expect.unreachable();
    } catch (err) {
      const text = String(err instanceof Error ? err.message : err);
      for (const value of Object.values(secrets)) {
        if (value === "preview") continue;
        expect(text).not.toContain(value);
      }
    }
  });
});
