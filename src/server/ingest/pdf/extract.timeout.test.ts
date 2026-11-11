import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unpdf = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  getMeta: vi.fn(),
}));
vi.mock("unpdf", () => unpdf);

import {
  extractionSlots,
  openPdf as openPdfReal,
  type OpenPdf,
} from "./extract";

// Everything opened here is closed after the test, even when an assertion
// fails halfway, so one failure cannot starve the next test of slots.
const opened: OpenPdf[] = [];
async function openPdf(bytes: Uint8Array, deadline: number): Promise<OpenPdf> {
  const doc = await openPdfReal(bytes, deadline);
  opened.push(doc);
  return doc;
}

const never = () => new Promise<never>(() => undefined);

/** A fake pdf.js document whose pages are supplied by the test. */
function fakePdf(overrides: Record<string, unknown> = {}) {
  const destroy = vi.fn(async () => undefined);
  const pdf = {
    numPages: 3,
    loadingTask: { destroy },
    getPage: vi.fn(never),
    ...overrides,
  };
  unpdf.getDocumentProxy.mockResolvedValue(pdf);
  unpdf.getMeta.mockResolvedValue({ info: {}, metadata: null });
  return { pdf, destroy };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
  unpdf.getDocumentProxy.mockReset();
  unpdf.getMeta.mockReset();
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((d) => d.close()));
  vi.useRealTimers();
});

const bytes = new Uint8Array([1, 2, 3]);
const BUDGET = 55_000;

describe("extraction deadline", () => {
  it("fails a page read with pdf_timeout at the deadline and frees everything", async () => {
    const { destroy } = fakePdf();
    const doc = await openPdf(bytes, Date.now() + BUDGET);
    const read = doc.readPage(1);
    const assertion = expect(read).rejects.toMatchObject({
      code: "pdf_timeout",
      httpStatus: 504,
      userMessage: "This PDF took too long to read. Try a smaller file.",
    });
    await vi.advanceTimersByTimeAsync(BUDGET + 1);
    await assertion;

    await doc.close();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(extractionSlots.active).toBe(0);
  });

  it("does not wait longer than the time that is left when a page is slow", async () => {
    fakePdf({
      getPage: vi.fn(async () => ({
        getTextContent: never,
        cleanup: vi.fn(),
      })),
    });
    // 10 s were already spent before opening (for example downloading a blob).
    const doc = await openPdf(bytes, Date.now() + 10_000);
    const read = doc.readPage(1);
    const assertion = expect(read).rejects.toMatchObject({
      code: "pdf_timeout",
    });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    await doc.close();
  });

  it("times out if the document never opens, and destroys it if it opens late", async () => {
    const destroy = vi.fn(async () => undefined);
    let finishOpening: (pdf: unknown) => void = () => undefined;
    unpdf.getDocumentProxy.mockReturnValue(
      new Promise((resolve) => (finishOpening = resolve)),
    );
    const opening = openPdf(bytes, Date.now() + 5000);
    const assertion = expect(opening).rejects.toMatchObject({
      code: "pdf_timeout",
    });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    expect(extractionSlots.active).toBe(0);

    finishOpening({ numPages: 1, loadingTask: { destroy } });
    await vi.advanceTimersByTimeAsync(0);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("refuses at once when the deadline has already passed", async () => {
    const { pdf } = fakePdf();
    const doc = await openPdf(bytes, Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(doc.readPage(1)).rejects.toMatchObject({
      code: "pdf_timeout",
    });
    expect(pdf.getPage).not.toHaveBeenCalled();
    await doc.close();
  });

  it("answers a third caller with pdf_timeout when both slots stay busy", async () => {
    fakePdf();
    const a = await openPdf(bytes, Date.now() + BUDGET);
    const b = await openPdf(bytes, Date.now() + BUDGET);
    expect(extractionSlots.active).toBe(2);

    const third = openPdf(bytes, Date.now() + 3000);
    const assertion = expect(third).rejects.toMatchObject({
      code: "pdf_timeout",
    });
    await vi.advanceTimersByTimeAsync(3001);
    await assertion;

    await a.close();
    await b.close();
    expect(extractionSlots.active).toBe(0);
  });

  it("lets a waiting caller in as soon as a slot frees up", async () => {
    fakePdf();
    const a = await openPdf(bytes, Date.now() + BUDGET);
    const b = await openPdf(bytes, Date.now() + BUDGET);
    const third = openPdf(bytes, Date.now() + BUDGET);
    await vi.advanceTimersByTimeAsync(100);
    expect(extractionSlots.waiting).toBe(1);

    await a.close();
    const c = await third;
    expect(c.numPages).toBe(3);
    await b.close();
    await c.close();
    expect(extractionSlots.active).toBe(0);
  });

  it("gives the slot back when opening fails", async () => {
    unpdf.getDocumentProxy.mockRejectedValue(
      Object.assign(new Error("No password given"), {
        name: "PasswordException",
      }),
    );
    await expect(openPdf(bytes, Date.now() + BUDGET)).rejects.toMatchObject({
      code: "pdf_encrypted",
    });
    expect(extractionSlots.active).toBe(0);
  });

  it("closing twice destroys the parser once", async () => {
    const { destroy } = fakePdf();
    const doc = await openPdf(bytes, Date.now() + BUDGET);
    await doc.close();
    await doc.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
