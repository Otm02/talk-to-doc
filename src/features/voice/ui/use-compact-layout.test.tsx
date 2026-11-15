// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEYBOARD_RATIO, useCompactLayout } from "./use-compact-layout";

function Probe(props: { composerOpen: boolean; textMode: boolean }) {
  const { compact, keyboardOpen } = useCompactLayout(props);
  return (
    <p
      data-testid="layout"
      data-compact={compact}
      data-keyboard={keyboardOpen}
    />
  );
}

const voice = { composerOpen: false, textMode: false };
const compact = () => screen.getByTestId("layout").getAttribute("data-compact");
const keyboard = () =>
  screen.getByTestId("layout").getAttribute("data-keyboard");
const cssVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

/** A phone: `inner` is window.innerHeight, the viewport starts out the same. */
function fakeViewport(inner = 844, width = 390) {
  const vv = Object.assign(new EventTarget(), {
    height: inner,
    offsetTop: 0,
    scale: 1,
  });
  vi.stubGlobal("visualViewport", vv);
  const set = (name: "innerHeight" | "innerWidth", value: number) =>
    Object.defineProperty(window, name, { configurable: true, value });
  set("innerHeight", inner);
  set("innerWidth", width);
  return {
    vv,
    /** The keyboard opens over the page: only the visual viewport shrinks (iOS). */
    overlay(height: number, offsetTop = 0) {
      vv.height = height;
      vv.offsetTop = offsetTop;
      act(() => void vv.dispatchEvent(new Event("resize")));
    },
    /** The browser resizes the layout for the keyboard (resizes-content, Android). */
    resize(height: number) {
      vv.height = height;
      set("innerHeight", height);
      act(() => void window.dispatchEvent(new Event("resize")));
    },
    rotate(nextWidth: number, height: number) {
      vv.height = height;
      set("innerWidth", nextWidth);
      set("innerHeight", height);
      act(() => void window.dispatchEvent(new Event("resize")));
    },
    /** Pinch zoom: the visible area shrinks by the zoom factor, the layout does not. */
    zoom(scale: number, offsetTop = 0) {
      vv.scale = scale;
      vv.height = inner / scale;
      vv.offsetTop = offsetTop;
      act(() => void vv.dispatchEvent(new Event("resize")));
    },
    scroll(offsetTop: number) {
      vv.offsetTop = offsetTop;
      act(() => void vv.dispatchEvent(new Event("scroll")));
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useCompactLayout", () => {
  it("is roomy for a voice chat with nothing open and the whole page visible", () => {
    fakeViewport();
    render(<Probe {...voice} />);
    expect(compact()).toBe("false");
    expect(keyboard()).toBe("false");
  });

  it("is compact while the composer is open", () => {
    fakeViewport();
    const { rerender } = render(<Probe composerOpen textMode={false} />);
    expect(compact()).toBe("true");
    expect(keyboard()).toBe("false");
    rerender(<Probe {...voice} />);
    expect(compact()).toBe("false");
  });

  it("is always compact in text mode", () => {
    fakeViewport();
    render(<Probe composerOpen={false} textMode />);
    expect(compact()).toBe("true");
  });

  it("goes compact when the keyboard covers more than a quarter of the page, and back", () => {
    const phone = fakeViewport(844);
    render(<Probe {...voice} />);

    phone.overlay(504); // 60% visible: keyboard up
    expect(keyboard()).toBe("true");
    expect(compact()).toBe("true");

    phone.overlay(844);
    expect(keyboard()).toBe("false");
    expect(compact()).toBe("false");
  });

  it("draws the line at about 75% of the full height", () => {
    const phone = fakeViewport(800);
    render(<Probe {...voice} />);
    expect(KEYBOARD_RATIO).toBe(0.75);

    phone.overlay(700); // a toolbar or a suggestion strip, not a keyboard
    expect(keyboard()).toBe("false");
    phone.overlay(600); // exactly 75%: not below it
    expect(keyboard()).toBe("false");
    phone.overlay(599);
    expect(keyboard()).toBe("true");
  });

  it("still sees the keyboard when the browser shrinks the layout viewport with it", () => {
    // interactive-widget=resizes-content: innerHeight follows the keyboard, so
    // visualViewport.height / innerHeight stays at 1. The full height is
    // remembered from before.
    const phone = fakeViewport(844);
    render(<Probe {...voice} />);
    phone.resize(420);
    expect(keyboard()).toBe("true");
    phone.resize(844);
    expect(keyboard()).toBe("false");
  });

  it("measures again after a rotation instead of calling landscape a keyboard", () => {
    const phone = fakeViewport(844, 390);
    render(<Probe {...voice} />);
    phone.rotate(844, 390);
    expect(keyboard()).toBe("false");
    phone.overlay(180);
    expect(keyboard()).toBe("true");
  });

  it("publishes --vvh and --vvt, on resize and on scroll", () => {
    const phone = fakeViewport(844);
    render(<Probe {...voice} />);
    expect(cssVar("--vvh")).toBe("844px");
    expect(cssVar("--vvt")).toBe("0px");

    phone.overlay(503.6);
    expect(cssVar("--vvh")).toBe("504px");

    // iOS scrolls the page under the keyboard instead of resizing it.
    phone.scroll(120);
    expect(cssVar("--vvt")).toBe("120px");
    phone.scroll(-3); // rubber-band overscroll
    expect(cssVar("--vvt")).toBe("0px");
  });

  it("removes the variables when the screen goes away", () => {
    fakeViewport(844);
    const { unmount } = render(<Probe {...voice} />);
    expect(cssVar("--vvh")).toBe("844px");
    unmount();
    expect(cssVar("--vvh")).toBe("");
    expect(cssVar("--vvt")).toBe("");
  });

  it("drops the variables if the viewport API stops answering, rather than keep a stale height", () => {
    const phone = fakeViewport(844);
    render(<Probe {...voice} />);
    phone.overlay(504);
    expect(cssVar("--vvh")).toBe("504px");
    vi.stubGlobal("visualViewport", null);
    act(() => void window.dispatchEvent(new Event("resize")));
    // Back to the CSS fallback (100dvh), which is always a whole screen.
    expect(cssVar("--vvh")).toBe("");
    expect(keyboard()).toBe("false");
  });

  it("forgets the old screen's height once nothing is mounted", () => {
    const phone = fakeViewport(844);
    const first = render(<Probe {...voice} />);
    first.unmount();
    // A shorter window, opened fresh: that is its full height, not a keyboard.
    phone.resize(420);
    render(<Probe {...voice} />);
    expect(keyboard()).toBe("false");
  });

  it("falls back to the composer and mode alone without visualViewport", () => {
    vi.stubGlobal("visualViewport", null);
    const { rerender } = render(<Probe {...voice} />);
    expect(compact()).toBe("false");
    expect(keyboard()).toBe("false");
    expect(cssVar("--vvh")).toBe("");
    rerender(<Probe composerOpen textMode={false} />);
    expect(compact()).toBe("true");
  });

  describe("pinch zoom", () => {
    it("zooming in is not a keyboard: the layout stays full and the vars stay put", () => {
      const f = fakeViewport();
      render(<Probe {...voice} />);
      expect(cssVar("--vvh")).toBe("844px");

      f.zoom(2, 120);
      expect(keyboard()).toBe("false");
      expect(compact()).toBe("false");
      expect(cssVar("--vvh")).toBe("844px");
      expect(cssVar("--vvt")).toBe("0px");

      f.zoom(3);
      expect(compact()).toBe("false");
      f.zoom(1);
      expect(compact()).toBe("false");
      expect(cssVar("--vvh")).toBe("844px");
    });

    it("a keyboard that opens while zoomed still counts", () => {
      const f = fakeViewport();
      render(<Probe {...voice} />);
      f.zoom(2);
      // 340 px of keyboard over a 2x zoom: 504 px of layout left to see.
      f.vv.height = 504 / 2;
      act(() => void f.vv.dispatchEvent(new Event("resize")));
      expect(keyboard()).toBe("true");
      expect(cssVar("--vvh")).toBe("504px");
    });

    it("a zoom just above rounding noise is ignored too, and 1.04 is not a zoom", () => {
      const f = fakeViewport();
      render(<Probe {...voice} />);
      f.zoom(1.04);
      // Not treated as zoom, so the 4% shorter area is read as it is, and 96% is no keyboard.
      expect(keyboard()).toBe("false");
      f.zoom(1.06);
      expect(keyboard()).toBe("false");
      expect(cssVar("--vvh")).toBe("844px");
    });
  });
});
