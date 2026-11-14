import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "@/lib/errors/catalog";
import { errorCopy } from "./error-copy";

describe("errorCopy", () => {
  it("uses the catalog message for every catalog code", () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(errorCopy(code).message).toBe(entry.message);
    }
  });

  it.each([
    ["pdf_too_large", "pick-another-file"],
    ["pdf_encrypted", "pick-another-file"],
    ["pdf_timeout", "retry"],
    ["upload_rejected", "retry"],
    ["upload_missing", "retry"],
    ["youtube_bad_url", "edit-link"],
    ["youtube_no_transcript", "edit-link"],
    ["youtube_failed", "retry"],
    ["rate_limited", "retry"],
    ["invalid_request", "reload"],
    ["internal", "retry"],
  ] as const)("%s offers %s", (code, action) => {
    expect(errorCopy(code).action).toBe(action);
  });

  it("offers a PDF when YouTube is blocked or out of quota", () => {
    expect(errorCopy("youtube_blocked").action).toBe("try-pdf");
    expect(errorCopy("youtube_quota").action).toBe("try-pdf");
  });

  it("matches the SPEC copy for upload_failed", () => {
    const spec = readFileSync(
      path.join(import.meta.dirname, "../../../docs/SPEC.md"),
      "utf-8",
    );
    const copy = errorCopy("upload_failed");
    expect(spec).toContain(copy.message);
    expect(copy.action).toBe("retry");
  });

  it("never shows an unknown code's text", () => {
    expect(errorCopy("weird_code").message).toBe(ERROR_CATALOG.internal.message);
  });
});
