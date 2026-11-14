// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type RealtimeState, type TranscriptItem } from "../realtime/state";
import { Transcript } from "./transcript";

function item(id: string, over: Partial<TranscriptItem>): TranscriptItem {
  return {
    id,
    role: "assistant",
    source: "voice",
    text: "",
    status: "done",
    responseId: null,
    prev: null,
    epoch: 1,
    arrival: 0,
    ...over,
  };
}
const stateWith = (...items: TranscriptItem[]): RealtimeState => ({
  ...initialState,
  items: Object.fromEntries(items.map((i) => [i.id, i])),
  order: items.map((i) => i.id),
});

describe("Transcript", () => {
  beforeEach(() => {
    // jsdom has no matchMedia.
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });

  it("is a polite live region with a hint when empty", () => {
    render(<Transcript state={stateWith()} onRetry={vi.fn()} empty="Say something" />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Say something")).toBeInTheDocument();
  });

  it("marks an interrupted answer and shows the transcribing placeholder", () => {
    render(
      <Transcript
        state={stateWith(
          item("u", { role: "user", status: "transcribing" }),
          item("a", { text: "Well, the", status: "interrupted" }),
        )}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    expect(screen.getByText("Transcribing…")).toBeInTheDocument();
    expect(screen.getByTestId("interrupted-marker")).toBeInTheDocument();
    expect(screen.getByText(/Well, the/)).toBeInTheDocument();
  });

  it("offers a retry for a message that did not send", () => {
    const onRetry = vi.fn();
    render(
      <Transcript
        state={stateWith(item("u", { role: "user", source: "text", text: "hi", status: "sendFailed" }))}
        onRetry={onRetry}
        empty=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /tap to retry/i }));
    expect(onRetry).toHaveBeenCalledWith("u");
  });

  it("stops following when the reader scrolls up and offers Jump to latest", () => {
    const view = render(
      <Transcript state={stateWith(item("a", { text: "one" }))} onRetry={vi.fn()} empty="" />,
    );
    const scroller = screen.getByLabelText("Conversation");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    scroller.scrollTop = 0; // far from the end
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();

    // New content arrives while scrolled up: position is left alone.
    view.rerender(
      <Transcript
        state={stateWith(item("a", { text: "one" }), item("b", { text: "two" }))}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    expect(scroller.scrollTop).toBe(0);

    scroller.scrollTo = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(scroller.scrollTo).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });
});
