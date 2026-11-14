import { describe, expect, it } from "vitest";
import type { DoneLine, MetaLine } from "@/lib/wire/ingest";
import { ingestReducer, initialIngestState, type IngestState } from "./ingest-state";

const meta: MetaLine = { documentId: "d", title: "T", sourceType: "pdf", pages: 2 };
const done: DoneLine = {
  done: true,
  stats: { pages: 2, words: 4, tokens: 5 },
  coverage: 0.5,
};

describe("ingestReducer", () => {
  it("walks upload → extract → ready", () => {
    let s: IngestState = ingestReducer(initialIngestState, {
      type: "upload-start",
      fileName: "a.pdf",
      size: 10,
    });
    s = ingestReducer(s, { type: "upload-progress", percent: 40 });
    expect(s).toMatchObject({ status: "uploading", percent: 40 });
    s = ingestReducer(s, { type: "extract-start" });
    expect(s).toEqual({ status: "extracting", doc: null });
    s = ingestReducer(s, { type: "meta", meta });
    s = ingestReducer(s, {
      type: "units",
      pages: [{ page: 1, text: "a" }],
      segments: [],
    });
    s = ingestReducer(s, { type: "done", done });
    expect(s).toMatchObject({ status: "ready" });
    expect(s.status === "ready" && s.doc.pages).toHaveLength(1);
  });

  it("a late extract-start does not wipe a document", () => {
    const s = ingestReducer(
      ingestReducer(initialIngestState, { type: "meta", meta }),
      { type: "extract-start" },
    );
    expect(s.status === "extracting" && s.doc?.meta.title).toBe("T");
  });

  it("ignores progress outside an upload", () => {
    expect(
      ingestReducer(initialIngestState, { type: "upload-progress", percent: 5 }),
    ).toBe(initialIngestState);
  });

  it("fails and resets", () => {
    const failed = ingestReducer(initialIngestState, {
      type: "fail",
      code: "pdf_empty",
    });
    expect(failed).toMatchObject({ status: "error", code: "pdf_empty" });
    expect(ingestReducer(failed, { type: "reset" })).toEqual(initialIngestState);
  });
});
