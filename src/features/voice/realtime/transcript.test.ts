import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./state";
import { isHidden, orderItems, visibleOrder } from "./transcript";

function item(
  id: string,
  prev: string | null | undefined,
  arrival: number,
  extra: Partial<TranscriptItem> = {},
): TranscriptItem {
  return {
    id,
    role: "user",
    source: "voice",
    text: "t",
    status: "done",
    responseId: null,
    prev,
    epoch: 1,
    arrival,
    ...extra,
  };
}

const map = (...items: TranscriptItem[]) =>
  Object.fromEntries(items.map((i) => [i.id, i]));

describe("orderItems", () => {
  it("follows previous_item_id chains, not arrival", () => {
    // Arrival: a2 and u2 landed before u1's announcement was processed.
    const items = map(
      item("a1", "u1", 3),
      item("u1", null, 1),
      item("u2", "a1", 5),
      item("a2", "u2", 4),
    );
    expect(orderItems(items)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("puts a late-announced user item before the reply that follows it", () => {
    const items = map(
      item("a1", "u1", 1, { role: "assistant" }),
      item("u1", null, 2),
    );
    expect(orderItems(items)).toEqual(["u1", "a1"]);
  });

  it("orders unlinked items (prev unknown or missing) by arrival", () => {
    const items = map(
      item("p2", undefined, 9),
      item("root", null, 1),
      item("orphan", "never-seen", 5),
    );
    expect(orderItems(items)).toEqual(["root", "orphan", "p2"]);
  });

  it("keeps sessions apart: older epochs come first", () => {
    const items = map(
      item("new1", null, 1, { epoch: 2 }),
      item("old1", null, 8, { epoch: 1 }),
      item("old2", "old1", 9, { epoch: 1 }),
    );
    expect(orderItems(items)).toEqual(["old1", "old2", "new1"]);
  });

  it("does not follow a link across epochs", () => {
    const items = map(
      item("a", null, 1, { epoch: 1 }),
      item("b", "a", 2, { epoch: 2 }),
    );
    expect(orderItems(items)).toEqual(["a", "b"]);
  });

  it("orders siblings that share a predecessor by arrival", () => {
    const items = map(
      item("r", null, 1),
      item("s2", "r", 3),
      item("s1", "r", 2),
    );
    expect(orderItems(items)).toEqual(["r", "s1", "s2"]);
  });

  it("survives a cycle and a self link without dropping or looping", () => {
    const items = map(item("a", "b", 1), item("b", "a", 2), item("c", "c", 3));
    const out = orderItems(items);
    expect([...out].sort()).toEqual(["a", "b", "c"]);
  });

  it("handles a long chain without recursion limits", () => {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 5000; i++)
      items.push(item(`i${i}`, i === 0 ? null : `i${i - 1}`, i));
    const out = orderItems(map(...items));
    expect(out).toHaveLength(5000);
    expect(out[4999]).toBe("i4999");
  });
});

describe("visibleOrder", () => {
  it("hides an interrupted answer with no words but keeps its chain", () => {
    const items = map(
      item("u1", null, 1),
      item("a1", "u1", 2, {
        role: "assistant",
        status: "interrupted",
        text: "",
      }),
      item("u2", "a1", 3),
    );
    expect(isHidden(items["a1"]!)).toBe(true);
    expect(visibleOrder(items)).toEqual(["u1", "u2"]);
  });

  it("shows an interrupted answer that has words", () => {
    const items = map(
      item("a1", null, 1, {
        role: "assistant",
        status: "interrupted",
        text: "Reven",
      }),
    );
    expect(visibleOrder(items)).toEqual(["a1"]);
  });
});
