import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  readStreamCapped,
  readTextPrefix,
} from "./read-capped";

/** A body that never ends: each pull is one more chunk. Counts the pulls. */
function endless(chunkBytes: number) {
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97)); // "a"
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

describe("readStreamCapped", () => {
  it("returns a body under the cap, and refuses one over it without reading on", async () => {
    const small = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    });
    expect(new TextDecoder().decode(await readStreamCapped(small, 10))).toBe(
      "hello",
    );

    const { body, state } = endless(1000);
    await expect(readStreamCapped(body, 2500)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThan(10);
  });
});

describe("readTextPrefix", () => {
  it("returns a short body whole", async () => {
    expect(await readTextPrefix(new Response('{"error":{}}'), 4096)).toBe(
      '{"error":{}}',
    );
  });

  it("returns nothing for a response with no body", async () => {
    expect(
      await readTextPrefix(new Response(null, { status: 502 }), 4096),
    ).toBe("");
  });

  it("stops at the cap on a body that never ends, and cancels the source", async () => {
    const { body, state } = endless(1000);
    const text = await readTextPrefix(new Response(body), 2500);
    expect(text).toHaveLength(2500);
    expect(state.cancelled).toBe(true);
    // A few chunks (the stream may read ahead a little), not a runaway.
    expect(state.pulls).toBeLessThan(10);
  });

  it("cuts exactly at the cap inside a chunk", async () => {
    expect(await readTextPrefix(new Response("abcdefghij"), 4)).toBe("abcd");
  });
});
