import { describe, expect, it } from "vitest";
import type { DoneLine, MetaLine } from "@/lib/wire/ingest";
import {
  ingestReducer,
  initialIngestState,
  type IngestState,
} from "./ingest-state";

const meta: MetaLine = {
  documentId: "d",
  title: "T",
  sourceType: "pdf",
  pages: 2,
};
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
      ingestReducer(initialIngestState, {
        type: "upload-progress",
        percent: 5,
      }),
    ).toBe(initialIngestState);
  });

  it("fails and resets", () => {
    const failed = ingestReducer(initialIngestState, {
      type: "fail",
      code: "pdf_empty",
    });
    expect(failed).toMatchObject({ status: "error", code: "pdf_empty" });
    expect(ingestReducer(failed, { type: "reset" })).toEqual(
      initialIngestState,
    );
  });
});

describe("ingestReducer: a slow or broken connection", () => {
  const uploading = ingestReducer(initialIngestState, {
    type: "upload-start",
    fileName: "a.pdf",
    size: 10,
  });

  it("flags a stalled upload, and any progress takes the flag away", () => {
    let s = ingestReducer(uploading, { type: "upload-progress", percent: 30 });
    s = ingestReducer(s, { type: "upload-stalled" });
    expect(s).toMatchObject({
      status: "uploading",
      percent: 30,
      stalled: true,
    });
    // Honest progress: the percent is never touched by the flag.
    expect(ingestReducer(s, { type: "upload-stalled" })).toBe(s);
    s = ingestReducer(s, { type: "upload-progress", percent: 31 });
    expect(s).toMatchObject({ percent: 31, stalled: false });
  });

  it("Keep waiting clears the flag without inventing progress", () => {
    let s = ingestReducer(uploading, { type: "upload-progress", percent: 30 });
    s = ingestReducer(s, { type: "upload-stalled" });
    s = ingestReducer(s, { type: "upload-resume" });
    expect(s).toMatchObject({ percent: 30, stalled: false });
    expect(ingestReducer(s, { type: "upload-resume" })).toBe(s);
  });

  it("ignores stall events outside an upload", () => {
    expect(ingestReducer(initialIngestState, { type: "upload-stalled" })).toBe(
      initialIngestState,
    );
    expect(ingestReducer(initialIngestState, { type: "upload-resume" })).toBe(
      initialIngestState,
    );
  });

  it("keeps the pages that arrived when the stream breaks", () => {
    let s = ingestReducer(uploading, { type: "extract-start" });
    s = ingestReducer(s, { type: "meta", meta });
    s = ingestReducer(s, {
      type: "units",
      pages: [{ page: 1, text: "a" }],
      segments: [],
    });
    s = ingestReducer(s, { type: "interrupt", code: "upload_failed" });
    expect(s).toMatchObject({ status: "partial", code: "upload_failed" });
    expect(s.status === "partial" && s.doc.pages).toHaveLength(1);
  });

  it("is a plain error when the stream broke before anything arrived", () => {
    const s = ingestReducer(
      ingestReducer(uploading, { type: "extract-start" }),
      { type: "interrupt", code: "youtube_failed" },
    );
    expect(s).toEqual({ status: "error", code: "youtube_failed" });
  });

  it("a new try replaces a partial document", () => {
    const partial: IngestState = {
      status: "partial",
      code: "upload_failed",
      doc: { meta, pages: [], segments: [], done: null },
    };
    expect(ingestReducer(partial, { type: "extract-start" })).toEqual({
      status: "extracting",
      doc: null,
    });
  });
});

describe("ingestReducer: loading a link again", () => {
  const ready: IngestState = {
    status: "ready",
    doc: {
      meta: { documentId: "d", title: "T", sourceType: "pdf", pages: 2 },
      pages: [{ page: 1, text: "a" }],
      segments: [],
      done: {
        done: true,
        stats: { pages: 2, words: 4, tokens: 5 },
        coverage: 1,
      },
    },
  };

  it("leaves a ready document and shows as loading", () => {
    expect(ingestReducer(ready, { type: "load-start" })).toEqual({
      status: "extracting",
      doc: null,
    });
  });

  it("extract-start still protects a ready document from a late upload event", () => {
    expect(ingestReducer(ready, { type: "extract-start" })).toBe(ready);
  });

  it("starts a load from any state", () => {
    for (const s of [
      initialIngestState,
      { status: "error", code: "youtube_failed" } as IngestState,
    ]) {
      expect(ingestReducer(s, { type: "load-start" })).toEqual({
        status: "extracting",
        doc: null,
      });
    }
  });
});
