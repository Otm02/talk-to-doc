// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTimer, TimeWarning, formatClock } from "./session-timer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("formatClock", () => {
  it("formats m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(-3)).toBe("0:00");
  });
});

describe("SessionTimer", () => {
  it("counts up and warns a minute before the cap", () => {
    let t = 1_000_000;
    render(<SessionTimer maxSeconds={300} now={() => t} />);
    expect(screen.getByTestId("session-timer")).toHaveAttribute("data-warning", "false");

    t += 239_000;
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("session-timer")).toHaveAttribute("data-warning", "false");

    t += 1_000; // 240 s: 60 s left
    act(() => void vi.advanceTimersByTime(1000));
    const el = screen.getByTestId("session-timer");
    expect(el).toHaveAttribute("data-warning", "true");
    expect(el).toHaveTextContent("4:00");
  });

  it("never warns when the cap is unknown", () => {
    render(<SessionTimer maxSeconds={null} now={() => 5} />);
    expect(screen.getByTestId("session-timer")).toHaveAttribute("data-warning", "false");
  });
});

describe("TimeWarning", () => {
  it("says about a minute left", () => {
    render(<TimeWarning secondsLeft={60} />);
    expect(screen.getByTestId("time-warning")).toHaveTextContent("1 minute left");
  });
});
