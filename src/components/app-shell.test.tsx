// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";
import { useAnnounceChatOpen } from "./chat-open";

function Chat() {
  useAnnounceChatOpen();
  return <p>chat</p>;
}

describe("AppShell", () => {
  it("renders the app name in the header and the page in main", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    expect(screen.getByRole("banner")).toHaveTextContent("Talk to a Doc");
    expect(screen.getByRole("main")).toHaveTextContent("page body");
  });

  it("is inert exactly while a chat screen is open, so focus and readers stay in the chat", () => {
    render(
      <AppShell>
        <button>Start voice chat</button>
      </AppShell>,
    );
    const root = screen.getByTestId("app-root");
    expect(root).not.toHaveAttribute("inert");

    // The chat lives outside the shell (a portal in <body>).
    const holder = document.body.appendChild(document.createElement("div"));
    const chat = render(<Chat />, { container: holder });
    expect(root).toHaveAttribute("inert");

    act(() => chat.unmount());
    expect(root).not.toHaveAttribute("inert");
    expect(
      screen.getByRole("button", { name: "Start voice chat" }),
    ).toBeInTheDocument();
  });
});
