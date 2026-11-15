// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markReachable,
  markUnreachable,
  resetConnectivityForTests,
} from "@/lib/net/connectivity";
import { useAnnounceChatOpen } from "./chat-open";
import { OfflineBanner } from "./offline-banner";

function setOnLine(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

beforeEach(() => {
  setOnLine(true);
  resetConnectivityForTests();
});
afterEach(() => setOnLine(true));

describe("OfflineBanner", () => {
  it("is absent while online", () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("appears when the browser goes offline, and goes when it is back", () => {
    render(<OfflineBanner />);
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "You're offline. We'll reconnect when you're back.",
    );
    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("also appears when a request got no answer, though the browser says online", () => {
    render(<OfflineBanner />);
    act(() => markUnreachable());
    expect(screen.getByTestId("offline-banner")).toBeInTheDocument();
    // Any answer from the server, even a refusal, takes it away.
    act(() => markReachable());
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });
});

describe("OfflineBanner: one voice while a chat is open", () => {
  function Chat() {
    useAnnounceChatOpen();
    return <OfflineBanner className="chat-banner" />;
  }
  const goOffline = () =>
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event("offline"));
    });

  const page = () => <OfflineBanner hideWhenChatOpen className="page-banner" />;

  it("the page's banner steps aside while a chat is open, and the chat's speaks", () => {
    render(
      <>
        {page()}
        <Chat />
      </>,
    );
    goOffline();
    const banners = screen.getAllByTestId("offline-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveClass("chat-banner");
  });

  it("the page's banner is back once the chat closes", () => {
    const { rerender } = render(
      <>
        {page()}
        <Chat />
      </>,
    );
    goOffline();
    expect(screen.getByTestId("offline-banner")).toHaveClass("chat-banner");
    rerender(page());
    expect(screen.getByTestId("offline-banner")).toHaveClass("page-banner");
  });

  it("with no chat open the page's banner shows", () => {
    render(<OfflineBanner hideWhenChatOpen />);
    goOffline();
    expect(screen.getByTestId("offline-banner")).toBeInTheDocument();
  });

  it("two chat screens cannot switch each other off", () => {
    const { rerender } = render(
      <>
        {page()}
        <Chat />
        <Chat />
      </>,
    );
    goOffline();
    // The page banner is hidden; both chat banners are shown.
    expect(
      screen
        .getAllByTestId("offline-banner")
        .every((b) => b.classList.contains("chat-banner")),
    ).toBe(true);
    // One of the chats unmounts: the other is still open, so the page stays quiet.
    rerender(
      <>
        {page()}
        <Chat />
      </>,
    );
    expect(screen.getByTestId("offline-banner")).toHaveClass("chat-banner");
  });
});
