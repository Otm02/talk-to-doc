import { describe, expect, it } from "vitest";
import { formatTimestamp } from "./timestamp";

describe("formatTimestamp", () => {
  it.each([
    [0, "00:00"],
    [5, "00:05"],
    [59.9, "00:59"],
    [60, "01:00"],
    [754, "12:34"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3725, "1:02:05"],
    [36000, "10:00:00"],
  ])("%s s -> %s", (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });

  it("clamps negative and non-finite input to zero", () => {
    expect(formatTimestamp(-4)).toBe("00:00");
    expect(formatTimestamp(Number.NaN)).toBe("00:00");
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe("00:00");
  });
});
