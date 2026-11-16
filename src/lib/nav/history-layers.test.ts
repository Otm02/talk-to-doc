// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushLayer, resetHistoryLayers } from "./history-layers";

/** jsdom traverses history asynchronously and reports it with popstate. */
function traverse(act: () => void): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("popstate", () => setTimeout(resolve, 0), {
      once: true,
    });
    act();
  });
}
const depth = () =>
  (window.history.state as { ttd?: number } | null)?.ttd ?? 0;
const settle = () => new Promise<void>((r) => setTimeout(r, 20));

beforeEach(() => {
  resetHistoryLayers();
  window.history.replaceState(null, "");
});
afterEach(() => resetHistoryLayers());

describe("history layers", () => {
  it("pushes one entry per layer, and Back closes the top one only", async () => {
    const chat = vi.fn(() => true);
    const sheet = vi.fn(() => true);
    pushLayer(chat);
    pushLayer(sheet);
    expect(depth()).toBe(2);

    await traverse(() => window.history.back());
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
    expect(depth()).toBe(1);

    await traverse(() => window.history.back());
    expect(chat).toHaveBeenCalledTimes(1);
    expect(depth()).toBe(0);
  });

  it("closing from the screen removes the entry without calling onBack", async () => {
    const onBack = vi.fn(() => true);
    const close = pushLayer(onBack);
    expect(depth()).toBe(1);

    await traverse(() => close());
    expect(depth()).toBe(0);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("two layers closed in the same render cost one traversal", async () => {
    const go = vi.spyOn(window.history, "go");
    const closeChat = pushLayer(() => true);
    const closeSheet = pushLayer(() => true);
    expect(depth()).toBe(2);

    await traverse(() => {
      closeSheet();
      closeChat();
    });
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-2);
    expect(depth()).toBe(0);
    go.mockRestore();
  });

  it("a layer that answers false stays, with its entry put back", async () => {
    let leaving = false;
    pushLayer(() => {
      leaving = true;
      return false;
    });
    await traverse(() => window.history.back());
    expect(leaving).toBe(true);
    expect(depth()).toBe(1);

    // And the next Back still reaches it.
    leaving = false;
    await traverse(() => window.history.back());
    expect(leaving).toBe(true);
  });

  it("a layer opened right after another closed reuses the entry", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const close = pushLayer(() => true);
    expect(push).toHaveBeenCalledTimes(1);
    // StrictMode, or one sheet replacing another in a single render.
    close();
    pushLayer(() => true);
    expect(push).toHaveBeenCalledTimes(1);
    await settle();
    expect(depth()).toBe(1);
    push.mockRestore();
  });

  it("a layer opened while a traversal is under way waits for it", async () => {
    const close = pushLayer(() => true);
    close();
    await Promise.resolve(); // the batched go(-1) has been issued, not landed
    const onBack = vi.fn(() => true);
    pushLayer(onBack);
    await settle();
    expect(depth()).toBe(1);

    await traverse(() => window.history.back());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(depth()).toBe(0);
  });

  it("a reload leaves an old marker behind: it counts as the page's own entry", () => {
    window.history.replaceState({ ttd: 3 }, "");
    resetHistoryLayers();
    pushLayer(() => true);
    expect(depth()).toBe(1);
  });

  it("closing something already closed by Back does nothing more", async () => {
    const onBack = vi.fn(() => true);
    const close = pushLayer(onBack);
    await traverse(() => window.history.back());
    expect(onBack).toHaveBeenCalledTimes(1);
    const go = vi.spyOn(window.history, "go");
    close();
    await settle();
    expect(go).not.toHaveBeenCalled();
    go.mockRestore();
  });
});
