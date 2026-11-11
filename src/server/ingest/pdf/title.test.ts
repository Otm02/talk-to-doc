import { describe, expect, it } from "vitest";
import { resolveTitle } from "./title";

describe("resolveTitle", () => {
  it("prefers the PDF metadata title", () => {
    expect(resolveTitle("Quarterly Report 2026", "upload.pdf")).toBe(
      "Quarterly Report 2026",
    );
  });

  it("falls back to the file name without .pdf", () => {
    expect(resolveTitle(undefined, "My Report.PDF")).toBe("My Report");
    expect(resolveTitle("", "notes.pdf")).toBe("notes");
    expect(resolveTitle("   ", "notes.pdf")).toBe("notes");
  });

  it("ignores placeholder titles left by authoring tools", () => {
    expect(resolveTitle("Untitled", "real-name.pdf")).toBe("real-name");
    expect(resolveTitle("Microsoft Word - draft3.docx", "real-name.pdf")).toBe(
      "real-name",
    );
  });

  it("strips a path from the file name", () => {
    expect(resolveTitle(undefined, "C:\\Users\\me\\scan.pdf")).toBe("scan");
    expect(resolveTitle(undefined, "/tmp/x/scan.pdf")).toBe("scan");
  });

  it("uses a generic title when there is nothing else", () => {
    expect(resolveTitle(undefined, undefined)).toBe("PDF document");
    expect(resolveTitle(undefined, ".pdf")).toBe("PDF document");
  });

  it("removes control and bidi characters and collapses spaces", () => {
    expect(resolveTitle("A\u0000B\u202ECD\n  E", undefined)).toBe("A B CD E");
  });

  it("caps the length", () => {
    expect(resolveTitle("x".repeat(500), undefined)).toHaveLength(200);
  });
});
