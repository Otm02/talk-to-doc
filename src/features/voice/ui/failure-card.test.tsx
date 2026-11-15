// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FailureCard } from "./failure-card";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const button = () => screen.getByTestId("retry-button");
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("FailureCard", () => {
  it("shows the copy for the code and retries on tap when there is no wait", () => {
    const onRetry = vi.fn();
    render(<FailureCard code="session_connect_failed" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't connect to voice chat. Try again.",
    );
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent(/^Try again$/);
    fireEvent.click(button());
    expect(onRetry).toHaveBeenCalledTimes(1);
    // No wait, so nothing to announce about one.
    expect(screen.queryByTestId("retry-wait-start")).toBeNull();
    expect(screen.getByTestId("retry-wait-end")).toBeEmptyDOMElement();
  });

  it("counts a 429 down every second and re-enables the action at 0", () => {
    const onRetry = vi.fn();
    render(
      <FailureCard
        code="rate_limited"
        retryAt={Date.now() + 72_000}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many tries. Try again when the timer ends.",
    );
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent("Try again in 1m 12s");

    tick(1000);
    expect(button()).toHaveTextContent("Try again in 1m 11s");
    tick(29_000);
    expect(button()).toHaveTextContent("Try again in 42s");
    fireEvent.click(button());
    expect(onRetry).not.toHaveBeenCalled();

    tick(41_000);
    expect(button()).toHaveTextContent("Try again in 1s");
    expect(button()).toBeDisabled();
    tick(1000);
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent(/^Try again$/);
    fireEvent.click(button());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("announces the wait at the start and the end, never on a tick", () => {
    render(
      <FailureCard
        code="rate_limited"
        retryAt={Date.now() + 72_000}
        onRetry={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    const end = screen.getByTestId("retry-wait-end");
    const spoken = () => `${alert.textContent} | ${end.textContent}`;

    // Start: read out with the error itself, in words.
    expect(alert).toHaveTextContent(
      "You can try again in 1 minute 12 seconds.",
    );
    expect(end).toHaveAttribute("role", "status");
    expect(end).toBeEmptyDOMElement();
    // The ticking button is not inside any live region.
    expect(
      button().closest('[role="alert"], [role="status"], [aria-live]'),
    ).toBeNull();

    const atStart = spoken();
    for (let i = 0; i < 71; i += 1) {
      tick(1000);
      expect(spoken()).toBe(atStart);
    }

    // End: one new sentence in the status line.
    tick(1000);
    expect(end).toHaveTextContent("You can try again now.");
    expect(alert).toHaveTextContent(
      "You can try again in 1 minute 12 seconds.",
    );
  });

  it("starts over when a second 429 brings a new deadline", () => {
    const { rerender } = render(
      <FailureCard
        code="rate_limited"
        retryAt={Date.now() + 5000}
        onRetry={vi.fn()}
      />,
    );
    tick(5000);
    expect(button()).toBeEnabled();

    rerender(
      <FailureCard
        code="rate_limited"
        retryAt={Date.now() + 538_000}
        onRetry={vi.fn()}
      />,
    );
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent("Try again in 8m 58s");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You can try again in 8 minutes 58 seconds.",
    );
    expect(screen.getByTestId("retry-wait-end")).toBeEmptyDOMElement();
  });

  it("shows the daily limit wait in hours and minutes", () => {
    render(
      <FailureCard
        code="daily_limit"
        retryAt={Date.now() + (7 * 3600 + 12 * 60) * 1000}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId("failure-card")).toHaveAttribute(
      "data-code",
      "daily_limit",
    );
    expect(button()).toHaveTextContent("Try again in 7h 12m");
  });
});
