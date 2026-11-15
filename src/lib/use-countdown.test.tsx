// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatWait,
  secondsUntil,
  spokenWait,
  useCountdown,
} from "./use-countdown";

function Probe({ deadline }: { deadline: number | null }) {
  const { secondsLeft, done } = useCountdown(deadline);
  return (
    <p data-testid="left" data-done={done}>
      {secondsLeft}
    </p>
  );
}

const left = () => screen.getByTestId("left").textContent;
const done = () => screen.getByTestId("left").getAttribute("data-done");
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("useCountdown", () => {
  it("ticks once a second down to 0 and then stops", () => {
    render(<Probe deadline={Date.now() + 3000} />);
    expect(left()).toBe("3");
    expect(done()).toBe("false");

    tick(1000);
    expect(left()).toBe("2");
    tick(1000);
    expect(left()).toBe("1");
    tick(1000);
    expect(left()).toBe("0");
    expect(done()).toBe("true");
    // Nothing is left running once the wait is over.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("changes exactly on the second, from a deadline that is not a round number", () => {
    render(<Probe deadline={Date.now() + 2400} />);
    expect(left()).toBe("3");
    tick(399);
    expect(left()).toBe("3");
    tick(1);
    expect(left()).toBe("2");
    tick(1000);
    expect(left()).toBe("1");
  });

  it("reads the clock, so a jump in time does not make it drift", () => {
    render(<Probe deadline={Date.now() + 72_000} />);
    expect(left()).toBe("72");

    // The phone slept for 30 s: the clock moved, no timer ran.
    vi.setSystemTime(Date.now() + 30_000);
    tick(1000);
    expect(left()).toBe("41");

    // Coming back to the tab catches up at once, without waiting for a tick.
    vi.setSystemTime(Date.now() + 20_500);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(left()).toBe("21");
    tick(500);
    expect(left()).toBe("20");
  });

  it("finishes at once when the clock is already past the deadline", () => {
    render(<Probe deadline={Date.now() + 5000} />);
    vi.setSystemTime(Date.now() + 60_000);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(left()).toBe("0");
    expect(done()).toBe("true");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows a new deadline", () => {
    const { rerender } = render(<Probe deadline={Date.now() + 2000} />);
    tick(2000);
    expect(done()).toBe("true");
    rerender(<Probe deadline={Date.now() + 10_000} />);
    expect(left()).toBe("10");
    tick(1000);
    expect(left()).toBe("9");
  });

  it("is done with no deadline, or one in the past, and sets no timer", () => {
    const { rerender } = render(<Probe deadline={null} />);
    expect(left()).toBe("0");
    expect(done()).toBe("true");
    rerender(<Probe deadline={Date.now() - 1} />);
    expect(done()).toBe("true");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops its timer on unmount", () => {
    const { unmount } = render(<Probe deadline={Date.now() + 60_000} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an injected clock", () => {
    function Fixed() {
      return (
        <p data-testid="left">{useCountdown(10_000, fixed).secondsLeft}</p>
      );
    }
    render(<Fixed />);
    expect(left()).toBe("9");
  });
});

const fixed = () => 1500;

describe("wait formatting", () => {
  it("rounds up to whole seconds and never goes below 0", () => {
    expect(secondsUntil(10_000, 9_001)).toBe(1);
    expect(secondsUntil(10_000, 10_000)).toBe(0);
    expect(secondsUntil(10_000, 99_000)).toBe(0);
  });

  it.each([
    [0, "0s"],
    [42, "42s"],
    [60, "1m 0s"],
    [72, "1m 12s"],
    [538, "8m 58s"],
    [3600, "1h 0m"],
    [25_920, "7h 12m"],
  ])("formats %i seconds as %s", (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });

  it.each([
    [1, "1 second"],
    [42, "42 seconds"],
    [60, "1 minute"],
    [72, "1 minute 12 seconds"],
    [538, "8 minutes 58 seconds"],
    [3600, "1 hour"],
    [25_920, "7 hours 12 minutes"],
  ])("says %i seconds as %s", (seconds, text) => {
    expect(spokenWait(seconds)).toBe(text);
  });
});
