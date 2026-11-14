// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAudioContext,
  createRemoteAudioElement,
  removeAudioElement,
} from "./audio";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createRemoteAudioElement", () => {
  it("makes an autoplaying, inline, hidden audio element in the page", () => {
    const el = createRemoteAudioElement();
    expect(el.autoplay).toBe(true);
    expect(el.hasAttribute("playsinline")).toBe(true);
    expect(el.hidden).toBe(true);
    expect(document.body.contains(el)).toBe(true);
  });

  it("detaches the stream and removes the element", () => {
    const el = createRemoteAudioElement();
    removeAudioElement(el);
    expect(el.srcObject).toBeNull();
    expect(document.body.contains(el)).toBe(false);
    expect(() => removeAudioElement(null)).not.toThrow();
  });
});

describe("createAudioContext", () => {
  it("creates and resumes a context", () => {
    const resume = vi.fn(async () => {});
    class Ctx {
      resume = resume;
    }
    const ctx = createAudioContext({ AudioContext: Ctx as never });
    expect(ctx).toBeInstanceOf(Ctx);
    expect(resume).toHaveBeenCalled();
  });

  it("uses the prefixed constructor on old WebKit", () => {
    class Ctx {
      resume = async () => {};
    }
    expect(
      createAudioContext({ webkitAudioContext: Ctx as never }),
    ).toBeInstanceOf(Ctx);
  });

  it("returns null when there is none, or the constructor throws", () => {
    expect(createAudioContext({})).toBeNull();
    class Boom {
      constructor() {
        throw new Error("blocked");
      }
    }
    expect(createAudioContext({ AudioContext: Boom as never })).toBeNull();
  });

  it("survives a context whose resume() rejects", () => {
    class Ctx {
      resume = () => Promise.reject(new Error("no gesture"));
    }
    expect(createAudioContext({ AudioContext: Ctx as never })).toBeInstanceOf(
      Ctx,
    );
  });
});
