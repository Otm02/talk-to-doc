import { afterEach, describe, expect, it } from "vitest";
import { pdfFixture } from "@test/fixtures";
import { buildBlankPages } from "../../../../scripts/make-fixtures";
import { AppError } from "../../errors";
import {
  extractionSlots,
  joinTextItems,
  mapPdfError,
  openPdf,
  type OpenPdf,
} from "./extract";
import { MAX_PDF_PAGES } from "./limits";
import { normalizePageText } from "./normalize";

const open = (bytes: Uint8Array) => openPdf(bytes, Date.now() + 30_000);

const opened: OpenPdf[] = [];
async function openTracked(bytes: Uint8Array): Promise<OpenPdf> {
  const doc = await open(bytes);
  opened.push(doc);
  return doc;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((d) => d.close()));
  // Every path, including failures, must give its slot back.
  expect(extractionSlots.active).toBe(0);
});

async function readAll(doc: OpenPdf): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    out.push(normalizePageText(await doc.readPage(page)));
  }
  return out;
}

describe("openPdf with real files", () => {
  it("reads every page of a normal PDF and its metadata title", async () => {
    const doc = await openTracked(pdfFixture("multi-page.pdf"));
    expect(doc.numPages).toBe(4);
    expect(doc.title).toBe("Quarterly Report 2026");
    const pages = await readAll(doc);
    expect(pages[0]).toContain("This report summarizes the results");
    expect(pages[1]).toMatch(/^Operations/);
    expect(pages[3]).toContain("Figures are unaudited");
  });

  it("recovers a paragraph break where the page has a blank line", async () => {
    const doc = await openTracked(pdfFixture("multi-page.pdf"));
    const first = await readAll(doc).then((p) => p[0]);
    expect(
      first?.startsWith("Quarterly Report\n\nThis report summarizes"),
    ).toBe(true);
    // Lines inside the same paragraph stay single-spaced.
    expect(first).toContain("Revenue grew\nby twelve percent");
  });

  it("keeps French accents and gives plain letters for ligatures", async () => {
    const doc = await openTracked(pdfFixture("french.pdf"));
    const [text] = await readAll(doc);
    expect(text).toContain("Résumé : l’œuvre de François Mauriac");
    expect(text).toContain("financement officiel");
    expect(text).toContain("fleuve a affligé");
    expect(text).toContain("bouffie");
    expect(text).toContain("“À côté du maître”");
    expect(text).not.toMatch(/[ﬀ-ﬆ]/);
  });

  it("joins words hyphenated across lines and keeps the other hyphens", async () => {
    const doc = await openTracked(pdfFixture("hyphenation.pdf"));
    const [text] = await readAll(doc);
    expect(text).toBe(
      [
        "The information was transmitted over a well-known",
        "network by Jean-",
        "Pierre in 2024-",
        "05 and reused later.",
      ].join("\n"),
    );
  });

  it("gives empty text for an image-only page", async () => {
    const doc = await openTracked(pdfFixture("image-only.pdf"));
    expect(doc.numPages).toBe(1);
    expect(await readAll(doc)).toEqual([""]);
  });

  it("reads the text pages around an image page", async () => {
    const doc = await openTracked(pdfFixture("partial-text.pdf"));
    const pages = await readAll(doc);
    expect(pages.map((p) => p.length > 0)).toEqual([true, false, true]);
  });

  it("extracts a file that only has an owner password", async () => {
    const doc = await openTracked(pdfFixture("owner-only.pdf"));
    const [text] = await readAll(doc);
    expect(text).toContain("A short protected document.");
  });

  it("accepts a Node Buffer (what a Blob download produces) and leaves it intact", async () => {
    const buffer = Buffer.from(pdfFixture("multi-page.pdf"));
    const before = buffer.length;
    const doc = await openTracked(buffer);
    expect(doc.numPages).toBe(4);
    await doc.readPage(1);
    expect(buffer.length).toBe(before); // not detached by pdf.js
  });

  it("opens a document with no pages", async () => {
    const doc = await openTracked(pdfFixture("empty.pdf"));
    expect(doc.numPages).toBe(0);
  });

  it("allows exactly 2,000 pages", async () => {
    const doc = await openTracked(buildBlankPages(MAX_PDF_PAGES));
    expect(doc.numPages).toBe(MAX_PDF_PAGES);
  });
});

describe("openPdf refusals", () => {
  const code = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (err: unknown) => (err instanceof AppError ? err.code : "not-app-error"),
    );

  it("maps a password-protected file to pdf_encrypted", async () => {
    const err = await open(pdfFixture("encrypted.pdf")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: "pdf_encrypted",
      httpStatus: 422,
      userMessage:
        "This PDF is password-protected. Remove the password and try again.",
    });
  });

  it("maps damaged bytes to pdf_corrupted", async () => {
    expect(await code(open(pdfFixture("corrupted.pdf")))).toBe("pdf_corrupted");
  });

  it("maps text that starts like nothing to pdf_corrupted if it ever reaches the parser", async () => {
    expect(await code(open(pdfFixture("renamed-text.pdf")))).toBe(
      "pdf_corrupted",
    );
  });

  it("refuses more than 2,000 pages before reading any", async () => {
    expect(await code(open(buildBlankPages(MAX_PDF_PAGES + 1)))).toBe(
      "pdf_too_many_pages",
    );
  });

  it("does not leak parser messages in the user copy", async () => {
    const err = await open(pdfFixture("corrupted.pdf")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).userMessage).not.toMatch(/structure|pdf\.js/i);
  });
});

describe("mapPdfError", () => {
  const named = (name: string) =>
    Object.assign(new Error("parser detail"), { name });

  it.each([
    ["PasswordException", "pdf_encrypted"],
    ["InvalidPDFException", "pdf_corrupted"],
    ["FormatError", "pdf_corrupted"],
    ["MissingPDFException", "pdf_unreadable"],
    ["UnexpectedResponseException", "pdf_unreadable"],
    ["TypeError", "pdf_unreadable"],
    ["", "pdf_unreadable"],
  ])("%s -> %s", (name, expected) => {
    const mapped = mapPdfError(named(name));
    expect(mapped.code).toBe(expected);
    expect(mapped.userMessage).not.toContain("parser detail");
  });

  it("maps anything else, including non-errors, to pdf_unreadable", () => {
    expect(mapPdfError("a string").code).toBe("pdf_unreadable");
    expect(mapPdfError(null).code).toBe("pdf_unreadable");
    expect(mapPdfError({ name: 42 }).code).toBe("pdf_unreadable");
  });

  it("keeps the original error as the cause for logs", () => {
    const original = named("InvalidPDFException");
    expect(mapPdfError(original).cause).toBe(original);
  });

  it("passes an AppError through unchanged", () => {
    const app = mapPdfError(named("PasswordException"));
    expect(mapPdfError(app)).toBe(app);
  });

  it("has the copy from the spec for the three mapped cases", () => {
    expect(mapPdfError(named("PasswordException")).userMessage).toBe(
      "This PDF is password-protected. Remove the password and try again.",
    );
    expect(mapPdfError(named("InvalidPDFException")).userMessage).toBe(
      "We couldn't open this PDF. It may be damaged.",
    );
    expect(mapPdfError(named("Whatever")).userMessage).toBe(
      "We couldn't read this PDF. Try a different file.",
    );
  });
});

describe("joinTextItems", () => {
  const line = (str: string, y: number | undefined, hasEOL = true) => ({
    str,
    hasEOL,
    transform: y === undefined ? undefined : [12, 0, 0, 12, 72, y],
  });

  it("joins items on a line and breaks at hasEOL", () => {
    const items = [
      { str: "Hello ", hasEOL: false, transform: [1, 0, 0, 1, 0, 700] },
      { str: "world", hasEOL: true, transform: [1, 0, 0, 1, 50, 700] },
      line("next line", 684),
    ];
    expect(joinTextItems(items)).toBe("Hello world\nnext line");
  });

  it("skips marked-content markers that have no text", () => {
    const items = [
      { type: "beginMarkedContent", id: "p1" },
      line("text", 700),
      { type: "endMarkedContent" },
    ];
    expect(joinTextItems(items)).toBe("text");
  });

  it("turns a gap over 1.5x the usual spacing into a blank line", () => {
    const items = [
      line("a", 700),
      line("b", 684),
      line("c", 652),
      line("d", 636),
    ];
    expect(joinTextItems(items)).toBe("a\nb\n\nc\nd");
  });

  it("does not add blank lines when spacing is even", () => {
    const items = [line("a", 700), line("b", 684), line("c", 668)];
    expect(joinTextItems(items)).toBe("a\nb\nc");
  });

  it("treats a jump back up the page (a new column) as a plain line break", () => {
    const items = [
      line("a", 700),
      line("b", 684),
      line("c", 668),
      line("col2", 700),
    ];
    expect(joinTextItems(items)).toBe("a\nb\nc\ncol2");
  });

  it("ignores empty lines when measuring and joining", () => {
    const items = [line("a", 700), line("", 692), line("b", 684)];
    expect(joinTextItems(items)).toBe("a\nb");
  });

  it("falls back to plain line breaks without positions", () => {
    const items = [line("a", undefined), line("b", undefined)];
    expect(joinTextItems(items)).toBe("a\nb");
  });

  it("keeps a final line that has no end-of-line flag", () => {
    expect(joinTextItems([line("a", 700), line("tail", 684, false)])).toBe(
      "a\ntail",
    );
  });

  it("returns an empty string for no items", () => {
    expect(joinTextItems([])).toBe("");
  });
});
