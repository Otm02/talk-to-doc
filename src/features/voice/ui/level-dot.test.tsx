// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LevelDot } from "./level-dot";

afterEach(() => vi.unstubAllGlobals());

function setup(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
  }));
  const listeners: Record<string, (level: number) => void> = {};
  const subscribe = vi.fn((kind: string, l: (level: number) => void) => {
    listeners[kind] = l;
    return () => {};
  });
  render(<LevelDot subscribeLevel={subscribe} />);
  return { subscribe, listeners, dot: screen.getByTestId("level-dot") };
}

describe("LevelDot", () => {
  it("swells with the louder of the two voices", () => {
    const { listeners, dot } = setup(false);
    expect(dot.style.getPropertyValue("--level")).toBe("0");
    listeners.mic?.(0.3);
    listeners.remote?.(0.7);
    expect(dot.style.getPropertyValue("--level")).toBe("0.7");
  });

  it("with reduced motion it never listens, so it never moves", () => {
    const { subscribe, dot } = setup(true);
    expect(subscribe).not.toHaveBeenCalled();
    expect(dot.style.getPropertyValue("--level")).toBe("0");
  });
});
