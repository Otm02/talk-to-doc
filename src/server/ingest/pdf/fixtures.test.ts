import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { pdfFixture } from "@test/fixtures";
import {
  buildFixtures,
  buildQuestionWav,
} from "../../../../scripts/make-fixtures";

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

describe("committed audio fixture", () => {
  const file = path.join(
    import.meta.dirname,
    "../../../../test/fixtures/audio/question.wav",
  );

  it("is exactly what scripts/make-fixtures.ts produces, so no recording of anyone is in the repo", () => {
    expect(readFileSync(file).equals(Buffer.from(buildQuestionWav()))).toBe(
      true,
    );
  });

  it("is 16 kHz mono 16-bit PCM, 3 seconds, and not silent", () => {
    const wav = readFileSync(file);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect((wav.length - 44) / 2 / 16_000).toBeCloseTo(3, 5);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(8_000);
  });
});
