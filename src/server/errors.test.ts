import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvError } from "./env";
import { AppError, catalogError, toErrorResult } from "./errors";

describe("toErrorResult", () => {
  it("maps AppError to its status and copy", () => {
    const r = toErrorResult(
      new AppError("rate_limited", "Slow down.", 429),
      "req-1",
    );
    expect(r).toEqual({
      status: 429,
      body: {
        error: { code: "rate_limited", message: "Slow down." },
        requestId: "req-1",
      },
    });
  });

  it("maps zod failures to invalid_request without leaking issue details", () => {
    const parsed = z
      .object({ url: z.string().url() })
      .safeParse({ url: "secret-input" });
    if (parsed.success) throw new Error("expected failure");
    const r = toErrorResult(parsed.error, "req-2");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
    expect(JSON.stringify(r.body)).not.toContain("secret-input");
  });

  it("maps EnvError to config_invalid", () => {
    const r = toErrorResult(new EnvError(["UPLOAD_MODE: bad"]), "req-3");
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("config_invalid");
    expect(r.body.error.message).toContain("UPLOAD_MODE");
  });

  it("turns unknown errors into a generic internal error", () => {
    const r = toErrorResult(
      new Error("upstream said: key sk-123 is bad\n at stack"),
      "req-4",
    );
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("internal");
    expect(JSON.stringify(r.body)).not.toMatch(/sk-123|stack/);
    expect(toErrorResult("a string", "req-5").status).toBe(500);
  });

  it("keeps the cause on AppError for logs", () => {
    const cause = new Error("boom");
    expect(new AppError("internal", "x", 500, cause).cause).toBe(cause);
  });

  it("builds errors from the catalog with their status and copy", () => {
    const err = catalogError("pdf_encrypted");
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(422);
    expect(err.userMessage).toBe(
      "This PDF is password-protected. Remove the password and try again.",
    );
    expect(catalogError("pdf_timeout", { cause: "x" }).cause).toBe("x");
  });

  it("maps a retry delay to a Retry-After header", () => {
    const r = toErrorResult(
      catalogError("rate_limited", { retryAfterSeconds: 42 }),
      "req-6",
    );
    expect(r.status).toBe(429);
    expect(r.headers).toEqual({ "retry-after": "42" });
  });

  it("sends no extra headers for ordinary errors", () => {
    expect(
      toErrorResult(catalogError("pdf_empty"), "req-7").headers,
    ).toBeUndefined();
  });

  it("uses the shared copy for zod and unknown failures", () => {
    const bad = z.object({ a: z.string() }).safeParse({});
    if (bad.success) throw new Error("expected failure");
    expect(toErrorResult(bad.error, "r").body.error.message).toBe(
      "Something was wrong with that request. Reload and try again.",
    );
    expect(toErrorResult(new Error("x"), "r").body.error.message).toBe(
      "Something went wrong on our side. Try again.",
    );
  });
});
