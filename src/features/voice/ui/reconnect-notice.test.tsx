// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../realtime/state";
import { ReconnectNotice } from "./reconnect-notice";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

type Reconnecting = Extract<ConnectionState, { status: "reconnecting" }>;
const rc = (over: Partial<Reconnecting>): Reconnecting => ({
  status: "reconnecting",
  since: 0,
  phase: "grace",
  attempt: 0,
  maxAttempts: 3,
  ...over,
});

describe("ReconnectNotice", () => {
  it("says the connection was interrupted during grace", () => {
    render(<ReconnectNotice connection={rc({})} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connection interrupted. Waiting for it to recover…",
    );
  });

  it.each(["backoff", "minting", "connecting"] as const)(
    "counts attempts in %s",
    (phase) => {
      render(<ReconnectNotice connection={rc({ phase, attempt: 2 })} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Reconnecting… (attempt 2 of 3)",
      );
    },
  );

  it("says it is waiting for the network, in the banner's words", () => {
    render(
      <ReconnectNotice
        connection={rc({ phase: "waitingNetwork", attempt: 1 })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "You're offline. We'll reconnect when you're back.",
    );
  });

  it("counts a cooldown down from a deadline, and announces it once", () => {
    render(
      <ReconnectNotice
        connection={rc({
          phase: "cooldown",
          attempt: 1,
          retryAt: Date.now() + 42_000,
        })}
      />,
    );
    const visible = () =>
      screen
        .getByTestId("reconnect-notice")
        .querySelector("[aria-hidden]:not(svg)");
    expect(visible()).toHaveTextContent("Reconnecting in 42s");
    act(() => void vi.advanceTimersByTime(10_000));
    expect(visible()).toHaveTextContent("Reconnecting in 32s");
    // What a screen reader gets does not tick.
    expect(screen.getByTestId("reconnect-notice")).toHaveTextContent(
      "Reconnecting in 42 seconds.",
    );
  });
});
