import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES } from "@/lib/limits";
import { checkPdfFile, checkPdfHeader } from "./validate-pdf";

const pdf = (over: Partial<Parameters<typeof checkPdfFile>[0]> = {}) => ({
  name: "a.pdf",
  type: "application/pdf",
  size: 1000,
  ...over,
});

describe("checkPdfFile", () => {
  it("accepts a PDF", () => {
    expect(checkPdfFile(pdf())).toEqual({ ok: true });
  });
  it("accepts a .pdf with an empty MIME type", () => {
    expect(checkPdfFile(pdf({ type: "" })).ok).toBe(true);
  });
  it("rejects other types", () => {
    expect(checkPdfFile(pdf({ name: "a.png", type: "image/png" }))).toEqual({
      ok: false,
      code: "pdf_not_pdf",
    });
  });
  it("rejects an empty file", () => {
    expect(checkPdfFile(pdf({ size: 0 }))).toEqual({
      ok: false,
      code: "pdf_empty",
    });
  });
  it("allows exactly 25 MB and rejects one byte more", () => {
    expect(checkPdfFile(pdf({ size: MAX_PDF_BYTES })).ok).toBe(true);
    expect(checkPdfFile(pdf({ size: MAX_PDF_BYTES + 1 }))).toEqual({
      ok: false,
      code: "pdf_too_large",
    });
  });
});

describe("checkPdfHeader", () => {
  const blob = (text: string) => new Blob([text]);

  it("accepts the header at the start, or within the first KiB", async () => {
    expect(await checkPdfHeader(blob("%PDF-1.7\n"))).toEqual({ ok: true });
    expect(await checkPdfHeader(blob(" ".repeat(1000) + "%PDF-1.4"))).toEqual({
      ok: true,
    });
  });

  it("rejects a file without it, and one that has it only after the first KiB", async () => {
    const notPdf = { ok: false, code: "pdf_not_pdf" };
    expect(await checkPdfHeader(blob("PK\u0003\u0004 a docx"))).toEqual(notPdf);
    expect(await checkPdfHeader(blob(" ".repeat(1100) + "%PDF-1.4"))).toEqual(
      notPdf,
    );
    expect(await checkPdfHeader(blob(""))).toEqual(notPdf);
  });

  it("lets a file through that cannot be read here: the server checks again", async () => {
    const unreadable = {
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error("gone")) }),
    } as unknown as Blob;
    expect(await checkPdfHeader(unreadable)).toEqual({ ok: true });
  });
});
