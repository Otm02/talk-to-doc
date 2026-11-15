import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateAdapters } from "@/server/state";
import { createMemoryAdapters } from "@/server/state/memory";

const holder = vi.hoisted(() => ({
  state: undefined as StateAdapters | undefined,
}));
vi.mock("@/server/state", () => ({
  getState: () => {
    if (!holder.state) throw new Error("test state not set");
    return holder.state;
  },
}));

import { loadInstructionDocument } from "./document";

// The store holds JSON of unknown provenance, so what comes back is parsed.
// Anything that is not a document we wrote is "not found", never a 500.

beforeEach(() => {
  holder.state = createMemoryAdapters();
});

const put = (id: string, doc: unknown) =>
  holder.state?.documents.put(id, doc as never, 60_000);

describe("loadInstructionDocument", () => {
  it("returns a PDF with its page count", async () => {
    await put("p", {
      sourceType: "pdf",
      title: "Report",
      context: "[Page 1] hi",
      coverage: 0.5,
      stats: { pages: 12, words: 3 },
    });
    expect(await loadInstructionDocument("p")).toEqual({
      source: "pdf",
      title: "Report",
      context: "[Page 1] hi",
      coverage: 0.5,
      pages: 12,
    });
  });

  it("returns a video with its duration and language", async () => {
    await put("y", {
      sourceType: "youtube",
      title: "Zoo",
      context: "[00:00] hi",
      coverage: 1,
      durationSec: 19,
      language: "en",
    });
    expect(await loadInstructionDocument("y")).toEqual({
      source: "youtube",
      title: "Zoo",
      context: "[00:00] hi",
      coverage: 1,
      durationSec: 19,
      language: "en",
    });
  });

  it("accepts a video record written before duration and language existed", async () => {
    await put("old", {
      sourceType: "youtube",
      title: "Old",
      context: "[00:00] hi",
      coverage: 1,
    });
    expect(await loadInstructionDocument("old")).toMatchObject({
      source: "youtube",
      durationSec: undefined,
      language: undefined,
    });
  });

  it.each([
    ["an unknown id", undefined],
    ["a string", "just text"],
    [
      "an unknown source type",
      { sourceType: "docx", title: "x", context: "y", coverage: 1 },
    ],
    [
      "empty context",
      {
        sourceType: "pdf",
        title: "x",
        context: "",
        coverage: 1,
        stats: { pages: 1 },
      },
    ],
    [
      "coverage above 1",
      {
        sourceType: "pdf",
        title: "x",
        context: "y",
        coverage: 1.5,
        stats: { pages: 1 },
      },
    ],
    [
      "a PDF without stats",
      { sourceType: "pdf", title: "x", context: "y", coverage: 1 },
    ],
    [
      "a negative duration",
      {
        sourceType: "youtube",
        title: "x",
        context: "y",
        coverage: 1,
        durationSec: -1,
      },
    ],
  ])("says doc_not_found for %s", async (_name, doc) => {
    if (doc !== undefined) await put("bad", doc);
    await expect(loadInstructionDocument("bad")).rejects.toMatchObject({
      code: "doc_not_found",
    });
  });
});
