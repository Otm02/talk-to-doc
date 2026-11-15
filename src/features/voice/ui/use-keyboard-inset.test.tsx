// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardInset } from "./use-keyboard-inset";

function Probe() {
  return <p data-testid="inset">{useKeyboardInset()}</p>;
}

function fakeViewport(height: number, offsetTop = 0) {
  const vv = Object.assign(new EventTarget(), { height, offsetTop });
  vi.stubGlobal("visualViewport", vv);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  return vv;
}

afterEach(() => vi.unstubAllGlobals());

describe("useKeyboardInset", () => {
  it("is the height the keyboard covers, and follows resizes", () => {
    const vv = fakeViewport(800);
    render(<Probe />);
    expect(screen.getByTestId("inset").textContent).toBe("0");

    vv.height = 500; // keyboard opens
    act(() => void vv.dispatchEvent(new Event("resize")));
    expect(screen.getByTestId("inset").textContent).toBe("300");

    vv.height = 800;
    act(() => void vv.dispatchEvent(new Event("resize")));
    expect(screen.getByTestId("inset").textContent).toBe("0");
  });

  it("accounts for a scrolled visual viewport and never goes negative", () => {
    const vv = fakeViewport(500, 100);
    render(<Probe />);
    expect(screen.getByTestId("inset").textContent).toBe("200");
    vv.offsetTop = 400;
    act(() => void vv.dispatchEvent(new Event("scroll")));
    expect(screen.getByTestId("inset").textContent).toBe("0");
  });

  it("does nothing without visualViewport", () => {
    vi.stubGlobal("visualViewport", null);
    render(<Probe />);
    expect(screen.getByTestId("inset").textContent).toBe("0");
  });
});
