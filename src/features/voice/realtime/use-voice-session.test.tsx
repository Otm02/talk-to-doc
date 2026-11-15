// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, type Harness } from "@test/realtime/harness";
import { scenarioScript } from "./mock-scenarios";
import { useVoiceSession } from "./use-voice-session";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Api = ReturnType<typeof useVoiceSession>;

/** Renders the hook and exposes its latest value. */
function mountHook(
  h: Harness,
  documentId = "doc-1",
  wrap?: (c: ReactNode) => ReactNode,
) {
  const ref: { current: Api | null } = { current: null };
  function Probe({ id }: { id: string }) {
    ref.current = useVoiceSession(id, { deps: h.deps });
    return (
      <p data-testid="status">
        {ref.current.state.connection.status}:{ref.current.state.order.length}
      </p>
    );
  }
  const tree = (id: string) =>
    wrap ? wrap(<Probe id={id} />) : <Probe id={id} />;
  const view = render(tree(documentId));
  const api = () => {
    if (!ref.current) throw new Error("hook did not render");
    return ref.current;
  };
  return {
    ...view,
    api,
    rerenderWith: (id: string) => view.rerender(tree(id)),
  };
}

const settle = (ms: number) =>
  act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("useVoiceSession", () => {
  it("starts idle, and exposes state, actions and a level feed", () => {
    const h = makeHarness();
    const { api } = mountHook(h);
    expect(api().state.connection.status).toBe("idle");
    expect(api().estimatedCost).toBeNull();
    expect(api().model).toBeNull();
    expect(typeof api().subscribeLevel).toBe("function");
    expect(Object.keys(api().actions).sort()).toEqual([
      "downloadEvents",
      "enableMic",
      "end",
      "retryText",
      "sendText",
      "setMuted",
      "start",
      "stopAnswer",
    ]);
  });

  it("re-renders as the chat progresses and prices the session", async () => {
    const h = makeHarness({ script: scenarioScript("text-turn") });
    const { api } = mountHook(h);
    act(() => api().actions.start("text"));
    await settle(100);
    expect(screen.getByTestId("status").textContent).toBe("connected:0");
    expect(api().model).toBe("gpt-realtime-2.1-mini");
    expect(api().maxSessionSeconds).toBe(300);

    act(() => api().actions.sendText("What was revenue?"));
    await settle(1500);
    expect(screen.getByTestId("status").textContent).toBe("connected:2");
    // The mock reply carries a usage block, priced on the model the server named.
    expect(api().estimatedCost?.usd).toBeGreaterThan(0);
    expect(api().state.usage.responses).toBe(1);
  });

  it("turns a text chat into a voice chat through the same session", async () => {
    const h = makeHarness();
    const { api } = mountHook(h);
    act(() => api().actions.start("text"));
    await settle(100);
    expect(api().state.mode).toBe("text");

    act(() => api().actions.enableMic());
    expect(api().state.micRetry).toBe("working");
    await settle(10);
    expect(api().state.mode).toBe("voice");
    expect(api().state.micRetry).toBe("idle");
    expect(h.mint).toHaveBeenCalledOnce();
    // The other controls go through the same session too.
    act(() => api().actions.setMuted(true));
    expect(api().state.muted).toBe(true);
    act(() => api().actions.stopAnswer());
    act(() => api().actions.retryText("missing"));
    act(() => api().actions.end());
    expect(api().state.connection.status).toBe("ended");
  });

  it("keeps its actions and level feed stable across renders", async () => {
    const h = makeHarness();
    const { api } = mountHook(h);
    const first = api();
    act(() => api().actions.start("text"));
    await settle(100);
    expect(api().actions).toBe(first.actions);
    expect(api().subscribeLevel).toBe(first.subscribeLevel);
  });

  it("ends the chat and gives everything back when the component unmounts", async () => {
    const h = makeHarness();
    const { api, unmount } = mountHook(h);
    act(() => api().actions.start("voice"));
    await settle(100);
    expect(h.transport.closeCount).toBe(0);
    unmount();
    expect(h.transport.closeCount).toBe(1);
    h.expectAllReleased();
  });

  it("survives React strict mode's mount, unmount, mount", async () => {
    const h = makeHarness();
    const { api } = mountHook(h, "doc-1", (c) => <StrictMode>{c}</StrictMode>);
    act(() => api().actions.start("text"));
    await settle(100);
    expect(api().state.connection.status).toBe("connected");
    expect(h.transports).toHaveLength(1);
  });

  it("ends the old chat when the document changes", async () => {
    const h = makeHarness();
    const { api, rerenderWith } = mountHook(h, "doc-1");
    act(() => api().actions.start("text"));
    await settle(100);
    expect(h.transport.closeCount).toBe(0);
    rerenderWith("doc-2");
    expect(h.transport.closeCount).toBe(1);
    expect(api().state.connection.status).toBe("idle");
    act(() => api().actions.start("text"));
    await settle(100);
    expect(h.mint).toHaveBeenLastCalledWith(
      "doc-2",
      expect.any(AbortSignal),
      [],
    );
  });

  it("downloads the dev event log only when there is one", async () => {
    const h = makeHarness({ recorder: true });
    const { api } = mountHook(h);
    act(() => api().actions.start("text"));
    await settle(100);
    const download = vi
      .spyOn(h.recorders[0]!, "download")
      .mockImplementation(() => {});
    api().actions.downloadEvents();
    expect(download).toHaveBeenCalledOnce();

    const off = makeHarness();
    const other = mountHook(off);
    expect(() => other.api().actions.downloadEvents()).not.toThrow();
  });
});
