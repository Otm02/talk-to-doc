import { describe, expect, it } from "vitest";
import { renderForModel, toParagraphs } from "./format";
import type { TranscriptSegment } from "./provider";

const seg = (startSec: number, text: string): TranscriptSegment => ({
  startMs: startSec * 1000,
  durMs: 2000,
  text,
});

describe("toParagraphs", () => {
  it("merges lines into ~30 s paragraphs stamped with their first line", () => {
    const segments = [
      seg(0, "a"),
      seg(10, "b"),
      seg(29, "c"),
      seg(30, "d"),
      seg(45, "e"),
      seg(61, "f"),
    ];
    expect(toParagraphs(segments)).toEqual([
      { startSec: 0, text: "a b c" },
      { startSec: 30, text: "d e" },
      { startSec: 61, text: "f" },
    ]);
  });

  it("starts the first paragraph where the first caption starts", () => {
    expect(toParagraphs([seg(5, "late start"), seg(7, "more")])).toEqual([
      { startSec: 5, text: "late start more" },
    ]);
  });

  it("does not glue lines across a long pause", () => {
    expect(toParagraphs([seg(0, "before"), seg(300, "after")])).toEqual([
      { startSec: 0, text: "before" },
      { startSec: 300, text: "after" },
    ]);
  });

  it("truncates a fractional start to whole seconds", () => {
    const [p] = toParagraphs([{ startMs: 12_999, durMs: 1, text: "x" }]);
    expect(p?.startSec).toBe(12);
  });

  it("returns nothing for no captions", () => {
    expect(toParagraphs([])).toEqual([]);
  });

  it("honours a custom paragraph length", () => {
    const segments = [seg(0, "a"), seg(10, "b"), seg(20, "c")];
    expect(toParagraphs(segments, 10)).toHaveLength(3);
  });
});

describe("renderForModel", () => {
  it("prefixes mm:ss under an hour and h:mm:ss after", () => {
    expect(
      renderForModel([
        { startSec: 0, text: "start" },
        { startSec: 754, text: "twelve minutes in" },
        { startSec: 3725, text: "past the hour" },
      ]),
    ).toBe(
      "[00:00] start\n\n[12:34] twelve minutes in\n\n[1:02:05] past the hour",
    );
  });

  it("separates paragraphs with a blank line so the token cap can cut between them", () => {
    const text = renderForModel([
      { startSec: 0, text: "a" },
      { startSec: 30, text: "b" },
    ]);
    expect(text.split(/\n{2,}/)).toHaveLength(2);
  });
});
