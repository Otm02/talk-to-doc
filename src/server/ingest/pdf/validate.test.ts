import { describe, expect, it } from "vitest";
import { pdfFixture } from "@test/fixtures";
import { MAX_PDF_BYTES } from "./limits";
import { assertPdfBytes } from "./validate";

const bytes = (s: string) => new TextEncoder().encode(s);

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof Error && "code" in err ? String(err.code) : "other";
  }
  return undefined;
}

describe("assertPdfBytes", () => {
  it("accepts a real PDF", () => {
    expect(
      codeOf(() => assertPdfBytes(pdfFixture("multi-page.pdf"))),
    ).toBeUndefined();
  });

  it("refuses zero bytes as pdf_empty", () => {
    expect(codeOf(() => assertPdfBytes(new Uint8Array(0)))).toBe("pdf_empty");
  });

  it("refuses text renamed to .pdf as pdf_not_pdf", () => {
    expect(codeOf(() => assertPdfBytes(pdfFixture("renamed-text.pdf")))).toBe(
      "pdf_not_pdf",
    );
  });

  it.each([
    ["PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["HTML", bytes("<!doctype html><title>x</title>")],
    ["ZIP/docx", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
    ["near miss", bytes("%PDF")],
    ["wrong case", bytes("%pdf-1.4")],
  ])("refuses %s", (_name, data) => {
    expect(codeOf(() => assertPdfBytes(data))).toBe("pdf_not_pdf");
  });

  it("accepts the header after up to 1,024 bytes of junk", () => {
    const junk = new Uint8Array(1000).fill(0x20);
    const data = Buffer.concat([junk, bytes("%PDF-1.4\nrest")]);
    expect(codeOf(() => assertPdfBytes(data))).toBeUndefined();
  });

  it("refuses the header when it starts past the first 1,024 bytes", () => {
    const junk = new Uint8Array(1030).fill(0x20);
    const data = Buffer.concat([junk, bytes("%PDF-1.4\nrest")]);
    expect(codeOf(() => assertPdfBytes(data))).toBe("pdf_not_pdf");
  });

  it("refuses more than 25 MB as pdf_too_large, checked before the header", () => {
    const data = new Uint8Array(MAX_PDF_BYTES + 1); // zeros: not even a PDF
    expect(codeOf(() => assertPdfBytes(data))).toBe("pdf_too_large");
  });

  it("accepts exactly 25 MB", () => {
    const data = new Uint8Array(MAX_PDF_BYTES);
    data.set(bytes("%PDF-1.4\n"));
    expect(codeOf(() => assertPdfBytes(data))).toBeUndefined();
  });

  it("looks at a view's own bytes, not the whole underlying buffer", () => {
    const backing = Buffer.concat([
      bytes("%PDF-1.4 other file"),
      bytes("not a pdf"),
    ]);
    const view = backing.subarray(20);
    expect(codeOf(() => assertPdfBytes(view))).toBe("pdf_not_pdf");
  });
});
