// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicBanner } from "./mic-banner";

const SAMSUNG =
  "Mozilla/5.0 (Linux; Android 16; SAMSUNG SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36";
const CHROME =
  "Mozilla/5.0 (Linux; Android 16; SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";

function as(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent });
}

const base = {
  reason: "denied",
  working: false,
  fails: 0,
  canRetry: true,
  sentText: false,
  onRetry: () => {},
} as const;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("MicBanner", () => {
  it("says why the chat is in text mode and keeps the retry one tap away", () => {
    as(CHROME);
    const onRetry = vi.fn();
    render(<MicBanner {...base} onRetry={onRetry} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Microphone unavailable, you're in text mode",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Microphone access is off.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Try microphone again" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The steps stay folded until a retry has actually failed.
    expect(screen.queryByTestId("mic-coach")).toBeNull();
  });

  it("folds the steps away when the user sends their first typed message, and the toggle reopens them", () => {
    as(CHROME);
    const { rerender } = render(<MicBanner {...base} fails={1} />);
    expect(screen.getByTestId("mic-coach")).toBeInTheDocument();

    rerender(<MicBanner {...base} fails={1} sentText />);
    expect(screen.queryByTestId("mic-coach")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "How to allow it" }));
    expect(screen.getByTestId("mic-coach")).toBeInTheDocument();
    // Later renders with the message still sent do not fold it again.
    rerender(<MicBanner {...base} fails={1} sentText />);
    expect(screen.getByTestId("mic-coach")).toBeInTheDocument();
  });

  it("folds only once: a user who already sent text and then fails a retry sees the steps", () => {
    as(CHROME);
    const { rerender } = render(<MicBanner {...base} sentText />);
    rerender(<MicBanner {...base} sentText fails={1} />);
    expect(screen.getByTestId("mic-coach")).toBeInTheDocument();
  });

  it("opens the steps by itself after a failed retry, tailored to Chrome", () => {
    as(CHROME);
    const { rerender } = render(<MicBanner {...base} />);
    rerender(<MicBanner {...base} fails={1} />);
    const coach = screen.getByTestId("mic-coach");
    expect(coach).toHaveTextContent(
      "Tap the tune icon left of the address bar.",
    );
    expect(coach).toHaveTextContent(
      "Open Android Settings, then Apps, Chrome, Permissions, Microphone.",
    );
    // Brought into view: the banner may have scrolled away with the chat.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
    });
    // The button did not go anywhere.
    expect(
      screen.getByRole("button", { name: "Try microphone again" }),
    ).toBeEnabled();
  });

  it("tailors the first line to Samsung Internet", () => {
    as(SAMSUNG);
    render(<MicBanner {...base} fails={2} />);
    const coach = screen.getByTestId("mic-coach");
    expect(coach).toHaveTextContent(
      "Tap the lock icon left of the address bar.",
    );
    expect(coach).toHaveTextContent(
      "Samsung Internet, Permissions, Microphone.",
    );
    expect(coach).not.toHaveTextContent("tune icon");
  });

  it.each([
    ["not_found", "No microphone found."],
    ["in_use", "Your microphone is busy in another app."],
  ] as const)("shows the copy and the steps for %s too", (reason, copy) => {
    as(CHROME);
    render(<MicBanner {...base} reason={reason} fails={1} />);
    expect(screen.getByRole("status")).toHaveTextContent(copy);
    expect(screen.getByTestId("mic-coach")).toBeInTheDocument();
  });

  it("shows it is checking without taking the button away", () => {
    as(CHROME);
    render(<MicBanner {...base} working />);
    const button = screen.getByRole("button", { name: "Checking microphone…" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("cannot retry while the chat is not connected", () => {
    as(CHROME);
    render(<MicBanner {...base} canRetry={false} />);
    expect(
      screen.getByRole("button", { name: "Try microphone again" }),
    ).toBeDisabled();
  });

  it.each(["insecure", "unsupported"] as const)(
    "offers no permission steps when the page cannot have a mic at all (%s)",
    (reason) => {
      as(CHROME);
      render(<MicBanner {...base} reason={reason} fails={3} />);
      expect(
        screen.queryByRole("button", { name: "How to allow it" }),
      ).toBeNull();
      expect(screen.queryByTestId("mic-coach")).toBeNull();
    },
  );
});
