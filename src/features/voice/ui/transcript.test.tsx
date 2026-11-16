// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initialState,
  type RealtimeState,
  type TranscriptItem,
} from "../realtime/state";
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
    render(
      <Transcript
        state={stateWith()}
        onRetry={vi.fn()}
        empty="Say something"
      />,
    );
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

  it("shows typing dots, not an empty bubble, while an answer has no words yet", () => {
    const { rerender } = render(
      <Transcript
        state={stateWith(item("a", { text: "", status: "streaming" }))}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    const bubble = screen.getByTestId("item-assistant");
    expect(screen.getByTestId("typing-dots")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    // Nothing for a screen reader to read yet: no dangling "Assistant:".
    expect(bubble).toHaveTextContent("");

    rerender(
      <Transcript
        state={stateWith(item("a", { text: "Revenue", status: "streaming" }))}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    expect(screen.queryByTestId("typing-dots")).toBeNull();
    expect(bubble).toHaveTextContent("Assistant: Revenue");
  });

  it("labels each bubble for screen readers and wraps the longest word", () => {
    render(
      <Transcript
        state={stateWith(
          item("u", { role: "user", text: "a".repeat(300) }),
          item("a", { text: "ok" }),
        )}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    expect(screen.getByTestId("item-user")).toHaveTextContent(/^You: a+$/);
    expect(screen.getByTestId("item-user").className).toContain(
      "[overflow-wrap:anywhere]",
    );
    // The list is a real list inside the log, so every bubble has a list parent.
    expect(screen.getByRole("log")).toContainElement(screen.getByRole("list"));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("leaves out the empty hint when there is none to give", () => {
    render(<Transcript state={stateWith()} onRetry={vi.fn()} empty="" />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("offers a retry for a message that did not send", () => {
    const onRetry = vi.fn();
    render(
      <Transcript
        state={stateWith(
          item("u", {
            role: "user",
            source: "text",
            text: "hi",
            status: "sendFailed",
          }),
        )}
        onRetry={onRetry}
        empty=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /tap to retry/i }));
    expect(onRetry).toHaveBeenCalledWith("u");
  });

  it("stops following when the reader scrolls up and offers Jump to latest", () => {
    const view = render(
      <Transcript
        state={stateWith(item("a", { text: "one" }))}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    const scroller = screen.getByLabelText("Conversation");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    scroller.scrollTop = 0; // far from the end
    fireEvent.scroll(scroller);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    // New content arrives while scrolled up: position is left alone.
    view.rerender(
      <Transcript
        state={stateWith(
          item("a", { text: "one" }),
          item("b", { text: "two" }),
        )}
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

describe("Transcript: the soft keyboard resizes the scroll area", () => {
  let fire: () => void;
  let size: { client: number; scroll: number };

  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    size = { client: 600, scroll: 1000 };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperties(HTMLElement.prototype, {
      clientHeight: { configurable: true, get: () => size.client },
      scrollHeight: { configurable: true, get: () => size.scroll },
    });
  });
  afterEach(() => {
    // Back to jsdom's own (always 0) getters.
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .clientHeight;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollHeight;
    vi.unstubAllGlobals();
  });

  const mount = () => {
    render(
      <Transcript
        state={stateWith(item("a", { text: "latest answer" }))}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    return screen.getByLabelText("Conversation");
  };

  it("keeps the newest answer in view when the keyboard shrinks the area", () => {
    const scroller = mount();
    scroller.scrollTop = 400; // at the end: 1000 - 400 - 600 = 0
    fireEvent.scroll(scroller);

    size.client = 180; // keyboard opens
    fire();
    expect(scroller.scrollTop).toBe(1000);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).toBeNull();
  });

  it("re-pins a reader who was within a short distance of the end", () => {
    const scroller = mount();
    scroller.scrollTop = 370; // 30 px from the end, inside the 48 px margin
    fireEvent.scroll(scroller);

    size.client = 180;
    fire();
    expect(scroller.scrollTop).toBe(1000);
  });

  it("leaves a reader who scrolled up where they were", () => {
    const scroller = mount();
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    size.client = 180;
    fire();
    expect(scroller.scrollTop).toBe(100);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });
});

describe("Transcript: the Reconnected divider", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });

  const dividers = () => screen.queryAllByTestId("reconnected-divider");

  it("draws one line before the first item of a reconnected session", () => {
    const base = stateWith(
      item("u1", { role: "user", text: "Hi", epoch: 1 }),
      item("a1", { text: "Hello", epoch: 1 }),
      item("u2", { role: "user", text: "Still there?", epoch: 2 }),
      item("a2", { text: "Yes", epoch: 2 }),
    );
    render(
      <Transcript
        state={{ ...base, epoch: 2, reconnectMarks: [2] }}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    expect(dividers()).toHaveLength(1);
    expect(
      screen.getByRole("separator", { name: "Reconnected" }),
    ).toBeInTheDocument();
    const list = screen.getByTestId("transcript").querySelector("ol");
    const order = [...(list?.children ?? [])].map(
      (el) => el.getAttribute("data-testid") ?? el.textContent,
    );
    // The divider sits between the old session and the new one.
    expect(order.indexOf("reconnected-divider")).toBe(2);
  });

  it("shows the line at the bottom while the new session has said nothing yet", () => {
    const base = stateWith(item("u1", { role: "user", text: "Hi", epoch: 1 }));
    render(
      <Transcript
        state={{ ...base, epoch: 2, reconnectMarks: [2] }}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    expect(dividers()).toHaveLength(1);
  });

  it("draws none for a chat that never reconnected", () => {
    render(
      <Transcript
        state={{
          ...stateWith(item("a1", { text: "Hello", epoch: 1 })),
          epoch: 1,
        }}
        onRetry={vi.fn()}
        empty=""
      />,
    );
    expect(dividers()).toHaveLength(0);
  });
});
