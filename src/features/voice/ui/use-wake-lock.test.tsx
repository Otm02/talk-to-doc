// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWakeLock } from "./use-wake-lock";

function Probe({ active }: { active: boolean }) {
  useWakeLock(active);
  return null;
}

function stubWakeLock() {
  const release = vi.fn(() => Promise.resolve());
  const request = vi.fn(() =>
    Promise.resolve({ release } as unknown as WakeLockSentinel),
  );
  vi.stubGlobal("navigator", { ...navigator, wakeLock: { request } });
  return { request, release };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
function setVisibility(v: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: v,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("useWakeLock", () => {
  it("holds the lock while active and releases when it stops", async () => {
    const w = stubWakeLock();
    const view = render(<Probe active />);
    await flush();
    expect(w.request).toHaveBeenCalledWith("screen");
    view.rerender(<Probe active={false} />);
    expect(w.release).toHaveBeenCalledTimes(1);
  });

  it("does nothing while inactive", async () => {
    const w = stubWakeLock();
    render(<Probe active={false} />);
    await flush();
    expect(w.request).not.toHaveBeenCalled();
  });

  it("lets go when hidden and takes it again when visible", async () => {
    const w = stubWakeLock();
    render(<Probe active />);
    await flush();
    setVisibility("hidden");
    expect(w.release).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await flush();
    expect(w.request).toHaveBeenCalledTimes(2);
  });

  it("never holds two locks when the page comes back while the first request is pending", async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    let settleFirst: () => void = () => {};
    const request = vi.fn(
      () =>
        new Promise<WakeLockSentinel>((resolve) => {
          const release = vi.fn(() => Promise.resolve());
          releases.push(release);
          const lock = { release } as unknown as WakeLockSentinel;
          if (request.mock.calls.length === 1)
            settleFirst = () => resolve(lock);
          else resolve(lock);
        }),
    );
    vi.stubGlobal("navigator", { ...navigator, wakeLock: { request } });

    const view = render(<Probe active />);
    // Back in the foreground while the first request has not answered yet.
    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settleFirst();
    await flush();
    expect(releases[0]).not.toHaveBeenCalled(); // that one is the lock we hold
    view.rerender(<Probe active={false} />);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("copes with a browser that refuses or lacks the API", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      wakeLock: { request: () => Promise.reject(new Error("denied")) },
    });
    render(<Probe active />);
    await flush();
    vi.stubGlobal("navigator", { userAgent: "x" });
    render(<Probe active />);
  });
});
