import { getPayloadFromClientToken } from "@vercel/blob/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../env";
import { createMemoryAdapters } from "../../state/memory";
import type { StateAdapters } from "../../state";

const holder = vi.hoisted(() => ({
  state: undefined as StateAdapters | undefined,
}));
vi.mock("../../state", () => ({
  getState: () => {
    if (!holder.state) throw new Error("test state not set");
    return holder.state;
  },
}));

import { POST } from "@/app/api/upload/token/route";

const TOKEN = "vercel_blob_rw_teststore123_secretpart";

function tokenRequest(
  pathname: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = { "x-forwarded-for": "203.0.113.5" },
) {
  return new Request("http://localhost/api/upload/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: { pathname, clientPayload: null, multipart: false },
      ...extra,
    }),
  });
}

beforeEach(() => {
  holder.state = createMemoryAdapters();
  vi.stubEnv("UPLOAD_MODE", "blob");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
  resetEnvCacheForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe("POST /api/upload/token", () => {
  it("issues a token limited to PDFs of 25 MB, with a random suffix and a short life", async () => {
    const before = Date.now();
    const res = await POST(tokenRequest("uploads/abc-123.pdf"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.type).toBe("blob.generate-client-token");

    // Decode what the SDK actually signed, rather than trusting our own call.
    const payload = getPayloadFromClientToken(body.clientToken);
    expect(payload.pathname).toBe("uploads/abc-123.pdf");
    expect(payload.allowedContentTypes).toEqual(["application/pdf"]);
    expect(payload.maximumSizeInBytes).toBe(25 * 1024 * 1024);
    expect(payload.addRandomSuffix).toBe(true);
    expect(payload.allowOverwrite).toBe(false);
    expect(payload.validUntil).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(payload.validUntil).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it("never puts the read-write token in the response", async () => {
    const res = await POST(tokenRequest("uploads/a.pdf"));
    expect(JSON.stringify(await res.json())).not.toContain("secretpart");
  });

  it.each([
    ["outside uploads/", "reports/a.pdf"],
    ["a nested path", "uploads/x/a.pdf"],
    ["not a pdf name", "uploads/a.exe"],
    ["path traversal", "uploads/../a.pdf"],
    ["a leading slash", "/uploads/a.pdf"],
    ["a space", "uploads/my file.pdf"],
    ["a very long name", `uploads/${"a".repeat(120)}.pdf`],
  ])("refuses a pathname %s", async (_name, pathname) => {
    const res = await POST(tokenRequest(pathname));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({
      code: "upload_rejected",
      message: "This upload wasn't allowed. Try again.",
    });
  });

  it("refuses events other than a token request", async () => {
    const res = await POST(
      new Request("http://localhost/api/upload/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.5",
        },
        body: JSON.stringify({
          type: "blob.upload-completed",
          payload: { blob: { url: "https://x" }, tokenPayload: null },
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it.each([
    ["not JSON", "{oops"],
    ["no payload", JSON.stringify({ type: "blob.generate-client-token" })],
    [
      "a non-boolean multipart",
      JSON.stringify({
        type: "blob.generate-client-token",
        payload: {
          pathname: "uploads/a.pdf",
          clientPayload: null,
          multipart: "yes",
        },
      }),
    ],
  ])("refuses a body that is %s", async (_name, body) => {
    const res = await POST(
      new Request("http://localhost/api/upload/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.5",
        },
        body,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it("is not available in direct mode", async () => {
    vi.stubEnv("UPLOAD_MODE", "direct");
    resetEnvCacheForTests();
    const res = await POST(tokenRequest("uploads/a.pdf"));
    expect(res.status).toBe(404);
  });

  it("reports a missing token as a config error that names the variable only", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    resetEnvCacheForTests();
    const res = await POST(tokenRequest("uploads/a.pdf"));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("config_invalid");
    expect(body.error.message).toContain("BLOB_READ_WRITE_TOKEN");
  });

  it("limits tokens per client, with Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await POST(tokenRequest("uploads/a.pdf"))).status).toBe(200);
    }
    const limited = await POST(tokenRequest("uploads/a.pdf"));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    const other = await POST(
      tokenRequest("uploads/a.pdf", {}, { "x-forwarded-for": "198.51.100.9" }),
    );
    expect(other.status).toBe(200);
  });

  it("turns an unexpected SDK failure into upload_rejected without leaking it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "garbage");
    resetEnvCacheForTests();
    const res = await POST(tokenRequest("uploads/a.pdf"));
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain("upload_rejected");
    expect(text).not.toContain("garbage");
  });
});
