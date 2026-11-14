// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventRecorder, parseJsonl } from "./recorder";

function clock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

afterEach(() => vi.restoreAllMocks());

describe("EventRecorder", () => {
  it("writes one JSON line per event with the time since the start", () => {
    const c = clock();
    const r = new EventRecorder(c.now);
    c.advance(250);
    r.recordIn('{"type":"session.created"}');
    c.advance(50);
    r.recordOut({ type: "response.cancel" });
    r.recordMeta({ model: "m" });
    const lines = r
      .toJsonl()
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { t: 250, dir: "in", data: { type: "session.created" } },
      { t: 300, dir: "out", data: { type: "response.cancel" } },
      { t: 300, dir: "meta", data: { model: "m" } },
    ]);
    expect(r.size).toBe(3);
  });

  it("redacts instructions anywhere in an event, never the rest", () => {
    const r = new EventRecorder();
    r.recordIn(
      JSON.stringify({
        type: "session.created",
        session: {
          instructions: "SECRET DOCUMENT TEXT and system rules",
          audio: { output: { voice: "marin" } },
          nested: [{ deep: { instructions: "also secret" } }],
        },
      }),
    );
    const out = r.toJsonl();
    expect(out).not.toContain("SECRET DOCUMENT TEXT");
    expect(out).not.toContain("also secret");
    expect(out).toContain("[redacted 37 chars]");
    expect(out).toContain("marin");
  });

  it("never keeps a client secret", () => {
    const r = new EventRecorder();
    r.recordOut({ note: "ek_test_not_a_real_secret" });
    expect(r.toJsonl()).not.toContain("ek_test_not");
  });

  it("redacts a secret wherever it sits in a string, not only at the start", () => {
    const r = new EventRecorder();
    r.recordOut({
      a: "Bearer ek_abcdef123456_XYZ",
      b: "x ek_abcdef123456 y ek_ZZZZZZ_9 z",
      list: ["ek_listsecret_001"],
    });
    const out = r.toJsonl();
    expect(out).not.toMatch(/ek_[A-Za-z0-9]/);
    expect(out).toContain("Bearer [redacted secret]");
    expect(out).toContain("x [redacted secret] y [redacted secret] z");
    // Words that merely start the same are left alone.
    r.recordOut({ note: "ek_ and ek_x are short" });
    expect(r.toJsonl()).toContain("ek_ and ek_x are short");
  });

  it("redacts instructions however deep they are nested, within reason", () => {
    const nest = (depth: number, leaf: unknown): unknown =>
      depth === 0 ? leaf : { next: nest(depth - 1, leaf) };
    const r = new EventRecorder();
    r.recordIn(JSON.stringify(nest(20, { instructions: "DEEP SECRET TEXT" })));
    expect(r.toJsonl()).not.toContain("DEEP SECRET TEXT");
    expect(r.toJsonl()).toContain("[redacted 16 chars]");
  });

  it("replaces anything nested absurdly deep instead of letting it through", () => {
    const nest = (depth: number, leaf: unknown): unknown =>
      depth === 0 ? leaf : { next: nest(depth - 1, leaf) };
    const r = new EventRecorder();
    r.recordIn(
      JSON.stringify(
        nest(60, { instructions: "BURIED SECRET", key: "ek_buriedsecret99" }),
      ),
    );
    const out = r.toJsonl();
    expect(out).not.toContain("BURIED SECRET");
    expect(out).not.toContain("ek_buriedsecret99");
    expect(out).toContain("[truncated: nested too deeply]");
  });

  it("keeps a bounded copy of input that is not JSON", () => {
    const r = new EventRecorder();
    r.recordIn("x".repeat(5000));
    const [entry] = parseJsonl(r.toJsonl());
    expect(entry?.data).toEqual({ unparsed: "x".repeat(2000) });
  });

  it("stops growing at the cap and says how many it dropped", () => {
    const r = new EventRecorder();
    for (let i = 0; i < 20_005; i++) r.recordIn('{"type":"x"}');
    expect(r.size).toBe(20_000);
    const last = r.toJsonl().trimEnd().split("\n").at(-1);
    expect(JSON.parse(last ?? "{}").data).toEqual({ dropped: 5 });
  });

  it("is empty after clear and exports nothing", () => {
    const r = new EventRecorder();
    r.recordIn('{"type":"x"}');
    r.clear();
    expect(r.size).toBe(0);
    expect(r.toJsonl()).toBe("");
  });

  it("downloads the log as a file", () => {
    const r = new EventRecorder();
    r.recordIn('{"type":"x"}');
    const create = vi.fn(() => "blob:fake");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      r.download("session.jsonl");
      expect(create).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(document.querySelector("a[download]")).toBeNull();
      // Not revoked at once: Safari can cancel the download if it is.
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(revoke).toHaveBeenCalledWith("blob:fake");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseJsonl", () => {
  it("round-trips and skips damaged lines", () => {
    const r = new EventRecorder(() => 5);
    r.recordIn('{"type":"a"}');
    const text = `${r.toJsonl()}{"t":1,"dir":"bogus"}\nnot json\n{"t":9,"dir":"out"}\n{"t":3,"di`;
    expect(parseJsonl(text)).toEqual([
      { t: 0, dir: "in", data: { type: "a" } },
      { t: 9, dir: "out", data: null },
    ]);
  });
});
