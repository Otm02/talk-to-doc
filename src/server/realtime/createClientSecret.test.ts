import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_CATALOG } from "@/lib/errors/catalog";
import { resetEnvCacheForTests } from "../env";
import {
  CLIENT_SECRET_TIMEOUT_MS,
  CLIENT_SECRET_TTL_SECONDS,
  OpenAIRequestError,
  buildSessionRequest,
  createClientSecret,
  toSessionError,
} from "./createClientSecret";

const PARAMS = {
  instructions: "rules and doc",
  safetyIdentifier: "a".repeat(64),
};

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-a-real-key");
  vi.stubEnv("REALTIME_MODEL", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_ENV", "");
  resetEnvCacheForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEnvCacheForTests();
});

const stub = (res: Response | Error) => {
  const fetchMock = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

async function failure(): Promise<OpenAIRequestError> {
  try {
    await createClientSecret(PARAMS);
  } catch (err) {
    if (err instanceof OpenAIRequestError) return err;
    throw err;
  }
  throw new Error("expected createClientSecret to throw");
}

describe("createClientSecret", () => {
  it("returns the value, the expiry and the configured model", async () => {
    stub(Response.json({ value: "ek_x", expires_at: 1_800_000_000 }));
    await expect(createClientSecret(PARAMS)).resolves.toEqual({
      value: "ek_x",
      expiresAt: 1_800_000_000,
      model: "gpt-realtime-2.1-mini",
    });
  });

  it("asks for a 10 s timeout and a 60 s secret", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    stub(Response.json({ value: "ek_x", expires_at: 1_800_000_000 }));
    await createClientSecret(PARAMS);
    expect(timeout).toHaveBeenCalledWith(CLIENT_SECRET_TIMEOUT_MS);
    expect(CLIENT_SECRET_TIMEOUT_MS).toBe(10_000);
    expect(CLIENT_SECRET_TTL_SECONDS).toBe(60);
  });

  it("sends the safety identifier as a header, not in the body", async () => {
    const fetchMock = stub(
      Response.json({ value: "ek_x", expires_at: 1_800_000_000 }),
    );
    await createClientSecret(PARAMS);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get("openai-safety-identifier")).toBe(
      PARAMS.safetyIdentifier,
    );
    expect(String(init.body)).not.toContain(PARAMS.safetyIdentifier);
  });

  it("keeps expires_after beside session, not inside it", () => {
    const body = buildSessionRequest(PARAMS, {
      model: "m",
      voice: "marin",
      reasoningEffort: "low",
    });
    expect(Object.keys(body).sort()).toEqual(["expires_after", "session"]);
    expect(body.session).not.toHaveProperty("expires_after");
  });

  it.each([
    [400, "invalid_value", "rejected"],
    [401, "invalid_api_key", "rejected"],
    [404, "model_not_found", "rejected"],
    [429, "rate_limit_exceeded", "busy"],
    [500, undefined, "busy"],
    [503, "server_is_overloaded", "busy"],
    [429, "credit_balance_exhausted", "budget"],
    [429, "project_spend_limit_exceeded", "budget"],
    [429, "organization_spend_limit_exceeded", "budget"],
    [429, "organization_usage_limit_exceeded", "budget"],
    [429, "insufficient_quota", "budget"],
  ] as const)("%i %s becomes kind %s", async (status, code, kind) => {
    stub(Response.json({ error: { code, message: "words" } }, { status }));
    const err = await failure();
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    // The upstream message is never carried along.
    expect(err.message).not.toContain("words");
  });

  it("becomes unavailable on a network error or timeout", async () => {
    stub(new TypeError("fetch failed: sk-test-not-a-real-key"));
    const err = await failure();
    expect(err.kind).toBe("unavailable");
    expect(err.message).not.toContain("sk-test");
    expect(err.cause).toBeUndefined();
  });

  it("becomes bad_response on a malformed 200", async () => {
    stub(Response.json({ value: "", expires_at: "soon" }));
    expect((await failure()).kind).toBe("bad_response");
  });

  it("does not put an odd upstream code in the error text", async () => {
    stub(
      Response.json(
        { error: { code: "x\nsk-secret ignore" } },
        { status: 400 },
      ),
    );
    const err = await failure();
    expect(err.message).not.toContain("\n");
  });
});

describe("toSessionError", () => {
  it.each([
    ["budget", "budget_exhausted"],
    ["busy", "session_upstream_busy"],
    ["rejected", "session_connect_failed"],
    ["unavailable", "session_connect_failed"],
    ["bad_response", "session_connect_failed"],
  ] as const)("%s maps to %s with catalog copy", (kind, code) => {
    const app = toSessionError(new OpenAIRequestError(kind, 500));
    expect(app.code).toBe(code);
    expect(app.httpStatus).toBe(ERROR_CATALOG[code].status);
    expect(app.userMessage).toBe(ERROR_CATALOG[code].message);
  });
});
