import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "@/server/env";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

describe("GET /api/health", () => {
  it("reports config without secrets", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-do-not-leak");
    const res = await GET(new Request("http://localhost/api/health"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      version: expect.any(String),
      model: "gpt-realtime-2.1-mini",
      uploadMode: "direct",
      state: "memory",
    });
    expect(JSON.stringify(body)).not.toContain("sk-test");
  });

  it("returns a readable config error when env is invalid", async () => {
    vi.stubEnv("REALTIME_MODEL", "nope-secret");
    const res = await GET(new Request("http://localhost/api/health"));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("config_invalid");
    expect(body.error.message).toContain("REALTIME_MODEL");
    expect(JSON.stringify(body)).not.toContain("nope-secret");
    expect(typeof body.requestId).toBe("string");
  });
});
