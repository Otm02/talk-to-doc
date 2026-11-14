import { describe, expect, it } from "vitest";
import { isDebug } from "./debug";

describe("isDebug", () => {
  it("is on in development", () => {
    expect(isDebug("", true)).toBe(true);
  });
  it("is off in production unless the URL asks", () => {
    expect(isDebug("", false)).toBe(false);
    expect(isDebug("?debug=1", false)).toBe(true);
    expect(isDebug("?a=b&debug=1", false)).toBe(true);
    expect(isDebug("?debug=0", false)).toBe(false);
    expect(isDebug("?debug=true", false)).toBe(false);
  });
  it("works with no location at all (server render)", () => {
    expect(isDebug(undefined, false)).toBe(false);
  });
});
