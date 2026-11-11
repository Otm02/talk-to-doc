import { describe, expect, it, vi } from "vitest";
import { IngestLineSchema, type IngestLine } from "@/lib/wire/ingest";
import { readNdjson } from "@/lib/wire/ndjson";
import { countTokens } from "../../context/budget";
import { catalogError } from "../../errors";
import { createMemoryDocumentStore } from "../../state/memory";
import type { PdfDocumentRecord } from "../record";
import type { OpenPdf } from "./extract";
import { createPdfIngestStream } from "./stream";

interface FakeDoc extends OpenPdf {
  closed: number;
  reads: number[];
}

function fakeDoc(
  pages: string[],
  options: { failOn?: number; error?: unknown; title?: string } = {},
): FakeDoc {
  const doc: FakeDoc = {
    numPages: pages.length,
    title: options.title,
    closed: 0,
    reads: [],
    async readPage(page) {
      doc.reads.push(page);
      if (page === options.failOn) throw options.error ?? new Error("boom");
      return pages[page - 1] ?? "";
    },
    async close() {
      doc.closed += 1;
    },
  };
  return doc;
}

const prose = (label: string, sentences = 6) =>
  Array.from(
    { length: sentences },
    (_, i) => `${label} sentence ${i} says something plain about the topic.`,
  ).join(" ");

function setup(doc: OpenPdf, overrides: { budget?: number } = {}) {
  const store = createMemoryDocumentStore();
  const stream = createPdfIngestStream({
    doc,
    documentId: "doc-1",
    title: "A Title",
    store,
    contextTokenBudget: overrides.budget ?? 8000,
    ttlMs: 60_000,
    requestId: "req-1",
    now: () => 1_700_000_000_000,
  });
  return { store, stream };
}

async function lines(
  stream: ReadableStream<Uint8Array>,
): Promise<IngestLine[]> {
  const out: IngestLine[] = [];
  for await (const line of readNdjson(stream, IngestLineSchema)) out.push(line);
  return out;
}

describe("createPdfIngestStream", () => {
  it("sends meta, one line per page in order, then done", async () => {
    const doc = fakeDoc([prose("one"), prose("two"), prose("three")]);
    const { stream } = setup(doc);
    const out = await lines(stream);

    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({
      documentId: "doc-1",
      title: "A Title",
      sourceType: "pdf",
      pages: 3,
    });
    expect(out.slice(1, 4)).toEqual([
      { page: 1, text: prose("one") },
      { page: 2, text: prose("two") },
      { page: 3, text: prose("three") },
    ]);
    expect(out[4]).toMatchObject({ done: true, coverage: 1 });
    expect(doc.closed).toBe(1);
  });

  it("normalizes each page's text", async () => {
    const doc = fakeDoc([`The oﬃce was informa-\ntion rich.   ${prose("x")}`]);
    const out = await lines(setup(doc).stream);
    expect(out[1]).toMatchObject({
      page: 1,
      text: expect.stringContaining("The office was information rich. "),
    });
  });

  it("reads pages only as the consumer pulls them", async () => {
    const doc = fakeDoc([prose("a"), prose("b"), prose("c"), prose("d")]);
    const { stream } = setup(doc);
    const reader = stream.getReader();
    await reader.read(); // meta
    await reader.read(); // page 1
    // One chunk of lookahead at most: pages 3 and 4 are not read yet.
    expect(doc.reads.length).toBeLessThanOrEqual(2);
    await reader.cancel();
  });

  it("lets the event loop run between pages so they reach the network early", async () => {
    // readPage here resolves in microtasks only, like pdf.js does. Without a
    // pause per page the whole file is processed before any I/O can happen.
    const doc = fakeDoc(Array.from({ length: 40 }, (_, i) => prose(`p${i}`)));
    const { stream } = setup(doc);
    let pagesSeenWhenMacrotaskRan = -1;
    let pagesSeen = 0;
    setImmediate(() => {
      pagesSeenWhenMacrotaskRan = pagesSeen;
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (decoder.decode(value).startsWith('{"page"')) pagesSeen += 1;
    }
    expect(pagesSeen).toBe(40);
    expect(pagesSeenWhenMacrotaskRan).toBeGreaterThanOrEqual(0);
    expect(pagesSeenWhenMacrotaskRan).toBeLessThan(5);
  });

  it("stores the record with stats, coverage and the full text when it fits", async () => {
    const pages = [prose("one"), "", prose("three")];
    const doc = fakeDoc(pages);
    const { store, stream } = setup(doc);
    const out = await lines(stream);
    const done = out.at(-1);

    const record = (await store.get("doc-1")) as PdfDocumentRecord | null;
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      id: "doc-1",
      sourceType: "pdf",
      title: "A Title",
      coverage: 1,
      createdAt: 1_700_000_000_000,
    });
    expect(record?.context).toBe(
      [
        `--- Page 1 ---\n${prose("one")}`,
        "--- Page 2 ---",
        `--- Page 3 ---\n${prose("three")}`,
      ].join("\n\n"),
    );
    expect(record?.stats).toEqual({
      pages: 3,
      words: pages.join(" ").split(/\s+/).filter(Boolean).length,
      tokens: countTokens(record?.context ?? ""),
    });
    expect(done).toEqual({
      done: true,
      stats: record?.stats,
      coverage: 1,
    });
  });

  it("keeps the record to the token budget and reports coverage", async () => {
    const pages = Array.from({ length: 40 }, (_, i) => prose(`page${i}`, 12));
    const doc = fakeDoc(pages);
    const { store, stream } = setup(doc, { budget: 1000 });
    const out = await lines(stream);
    const done = out.at(-1);
    const record = (await store.get("doc-1")) as PdfDocumentRecord;

    expect(record.stats.tokens).toBeGreaterThan(3000);
    expect(countTokens(record.context)).toBeLessThanOrEqual(1000);
    // Cut on a page boundary: a whole page, never half a page.
    expect(
      record.context.endsWith(
        prose("page" + (record.context.split("--- Page").length - 2), 12),
      ),
    ).toBe(true);
    expect(record.coverage).toBeCloseTo(1000 / record.stats.tokens, 10);
    expect(done).toMatchObject({ done: true, coverage: record.coverage });
    // The stream still carried every page; only the stored copy is capped.
    expect(out.filter((l) => "page" in l)).toHaveLength(40);
  });

  it("never stores the whole text of a big document", async () => {
    const pages = Array.from({ length: 30 }, (_, i) => prose(`p${i}`, 20));
    const { store, stream } = setup(fakeDoc(pages), { budget: 1000 });
    await lines(stream);
    const record = (await store.get("doc-1")) as PdfDocumentRecord;
    const fullLength = pages.join("").length;
    expect(record.context.length).toBeLessThan(fullLength / 3);
  });

  it("expires the record with the TTL", async () => {
    const doc = fakeDoc([prose("a")]);
    const store = createMemoryDocumentStore({ now: () => 0 });
    const put = vi.spyOn(store, "put");
    const stream = createPdfIngestStream({
      doc,
      documentId: "d",
      title: "t",
      store,
      contextTokenBudget: 8000,
      ttlMs: 7_200_000,
      requestId: "r",
    });
    await lines(stream);
    expect(put).toHaveBeenCalledWith("d", expect.any(Object), 7_200_000);
  });

  describe("scanned documents", () => {
    it("ends with a pdf_no_text error line and stores nothing", async () => {
      const doc = fakeDoc(["", "", ""]);
      const { store, stream } = setup(doc);
      const out = await lines(stream);
      expect(out.at(-1)).toEqual({
        error: {
          code: "pdf_no_text",
          message:
            "This PDF has no selectable text. It may be a scan. Try a PDF with real text.",
        },
      });
      expect(out.some((l) => "done" in l)).toBe(false);
      expect(await store.get("doc-1")).toBeNull();
      expect(doc.closed).toBe(1);
    });

    it("treats an average under 25 visible characters per page as a scan", async () => {
      const justUnder = fakeDoc(["x".repeat(24), "x".repeat(24)]);
      const out = await lines(setup(justUnder).stream);
      expect(out.at(-1)).toMatchObject({ error: { code: "pdf_no_text" } });
    });

    it("accepts an average of exactly 25, even with an empty page among them", async () => {
      const doc = fakeDoc(["x".repeat(50), ""]);
      const out = await lines(setup(doc).stream);
      expect(out.at(-1)).toMatchObject({ done: true });
    });

    it("counts letters, not spaces", async () => {
      const doc = fakeDoc(["a b c d e f g h i j k l m n o p q r s t u v w x"]);
      const out = await lines(setup(doc).stream);
      expect(out.at(-1)).toMatchObject({ error: { code: "pdf_no_text" } });
    });

    it("treats a document with no pages as having no text", async () => {
      const doc = fakeDoc([]);
      const { store, stream } = setup(doc);
      const out = await lines(stream);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ pages: 0 });
      expect(out[1]).toMatchObject({ error: { code: "pdf_no_text" } });
      expect(await store.get("doc-1")).toBeNull();
    });
  });

  describe("failures mid-stream", () => {
    it("sends an error line after the pages already sent, then ends", async () => {
      const doc = fakeDoc([prose("a"), prose("b"), prose("c")], {
        failOn: 2,
        error: catalogError("pdf_timeout"),
      });
      const { store, stream } = setup(doc);
      const out = await lines(stream);
      expect(out).toHaveLength(3); // meta, page 1, error
      expect(out[1]).toMatchObject({ page: 1 });
      expect(out[2]).toEqual({
        error: {
          code: "pdf_timeout",
          message: "This PDF took too long to read. Try a smaller file.",
        },
      });
      expect(await store.get("doc-1")).toBeNull();
      expect(doc.closed).toBe(1);
    });

    it("hides unexpected error details behind the generic copy", async () => {
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const doc = fakeDoc([prose("a")], {
        failOn: 1,
        error: new Error("secret upstream detail /srv/app/key"),
      });
      const out = await lines(setup(doc).stream);
      const last = out.at(-1);
      expect(last).toEqual({
        error: {
          code: "internal",
          message: "Something went wrong on our side. Try again.",
        },
      });
      expect(JSON.stringify(out)).not.toContain("secret upstream");
      // The detail still reaches the server log, with the request id.
      expect(log).toHaveBeenCalledWith("[req-1] internal", expect.any(Error));
      log.mockRestore();
    });

    it("reports a failed save as an error line, not a done line", async () => {
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const doc = fakeDoc([prose("a")]);
      const store = createMemoryDocumentStore();
      vi.spyOn(store, "put").mockRejectedValue(new Error("redis down"));
      const stream = createPdfIngestStream({
        doc,
        documentId: "d",
        title: "t",
        store,
        contextTokenBudget: 8000,
        ttlMs: 1000,
        requestId: "r",
      });
      const out = await lines(stream);
      expect(out.some((l) => "done" in l)).toBe(false);
      expect(out.at(-1)).toMatchObject({ error: { code: "internal" } });
      log.mockRestore();
    });

    it("passes AppError codes through", async () => {
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const doc = fakeDoc([prose("a")], {
        failOn: 1,
        error: catalogError("pdf_corrupted"),
      });
      const out = await lines(setup(doc).stream);
      expect(out.at(-1)).toMatchObject({ error: { code: "pdf_corrupted" } });
      log.mockRestore();
    });
  });

  describe("when the client goes away", () => {
    it("closes the document and stops reading", async () => {
      const doc = fakeDoc(Array.from({ length: 50 }, (_, i) => prose(`p${i}`)));
      const { store, stream } = setup(doc);
      const reader = stream.getReader();
      await reader.read();
      await reader.read();
      await reader.cancel();

      expect(doc.closed).toBe(1);
      const readsAtCancel = doc.reads.length;
      await new Promise((r) => setTimeout(r, 20));
      expect(doc.reads.length).toBe(readsAtCancel);
      expect(doc.reads.length).toBeLessThan(50);
      expect(await store.get("doc-1")).toBeNull();
    });
  });
});
