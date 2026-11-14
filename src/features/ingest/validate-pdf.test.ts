import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES } from "@/lib/limits";
import { checkPdfFile } from "./validate-pdf";

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
    expect(checkPdfFile(pdf({ size: 0 }))).toEqual({ ok: false, code: "pdf_empty" });
  });
  it("allows exactly 25 MB and rejects one byte more", () => {
    expect(checkPdfFile(pdf({ size: MAX_PDF_BYTES })).ok).toBe(true);
    expect(checkPdfFile(pdf({ size: MAX_PDF_BYTES + 1 }))).toEqual({
      ok: false,
      code: "pdf_too_large",
    });
  });
});
