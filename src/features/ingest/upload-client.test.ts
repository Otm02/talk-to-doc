import { describe, expect, it } from "vitest";
import { retryAfter } from "./upload-client";

describe("retryAfter", () => {
  it("prefers retryAfterSec from the error body", () => {
    expect(
      retryAfter({ error: { code: "rate_limited", retryAfterSec: 538 } }, "72"),
    ).toBe(538);
  });

  it("falls back to the Retry-After header", () => {
    expect(retryAfter({ error: { code: "rate_limited" } }, "72")).toBe(72);
    expect(retryAfter(null, "2.5")).toBe(3);
    expect(retryAfter("<html>", "10")).toBe(10);
  });

  it("ignores unusable values", () => {
    expect(
      retryAfter({ error: { retryAfterSec: "soon" } }, null),
    ).toBeUndefined();
    expect(retryAfter({ error: { retryAfterSec: -1 } }, "0")).toBeUndefined();
    expect(retryAfter({ error: null }, "abc")).toBeUndefined();
    expect(retryAfter(undefined, null)).toBeUndefined();
  });

  it("caps absurd waits so the retry button cannot be parked for days", () => {
    expect(retryAfter({ error: { retryAfterSec: 1e12 } }, null)).toBe(86_400);
    expect(retryAfter(null, "1e12")).toBe(3_600);
    expect(retryAfter(null, "  ")).toBeUndefined();
  });
});
