import { readdirSync } from "node:fs";
import path from "node:path";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { pdfFixture } from "@test/fixtures";
import { buildFixtures } from "../../../../scripts/make-fixtures";

const dir = path.join(import.meta.dirname, "../../../../test/fixtures/pdf");

describe("committed PDF fixtures", () => {
  const generated = buildFixtures();

  it("are exactly what scripts/make-fixtures.ts produces (run `pnpm fixtures`)", () => {
    expect(readdirSync(dir).sort()).toEqual([...generated.keys()].sort());
    for (const [name, bytes] of generated) {
      expect(
        Buffer.from(pdfFixture(name)).equals(Buffer.from(bytes)),
        name,
      ).toBe(true);
    }
  });

  it("includes a genuinely encrypted file: it needs its password and opens with it", async () => {
    // Guards the fixture itself, so the pdf_encrypted test cannot pass by accident
    // with a file that is merely malformed.
    await expect(
      getDocumentProxy(pdfFixture("encrypted.pdf")),
    ).rejects.toMatchObject({ name: "PasswordException" });
    const pdf = await getDocumentProxy(pdfFixture("encrypted.pdf"), {
      password: "secret",
    });
    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items
      .map((i) => ("str" in i ? i.str : ""))
      .join("");
    expect(text).toContain("A short protected document.");
    await pdf.loadingTask.destroy();
  });

  it("includes a file that only restricts permissions and opens without a password", async () => {
    const pdf = await getDocumentProxy(pdfFixture("owner-only.pdf"));
    expect(pdf.numPages).toBe(1);
    await pdf.loadingTask.destroy();
  });
});
