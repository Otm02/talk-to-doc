import { describe, expect, it } from "vitest";
import { ErrorBodySchema } from "./session";

describe("ErrorBodySchema", () => {
  it("keeps the code when retryAfterSec is malformed", () => {
    for (const bad of ["soon", -5, 0, null]) {
      const parsed = ErrorBodySchema.parse({
        error: { code: "rate_limited", retryAfterSec: bad },
      });
      expect(parsed.error.code).toBe("rate_limited");
      expect(parsed.error.retryAfterSec).toBeUndefined();
    }
  });

  it("passes a good wait through", () => {
    expect(
      ErrorBodySchema.parse({
        error: { code: "rate_limited", retryAfterSec: 42 },
      }).error.retryAfterSec,
    ).toBe(42);
  });
});
