import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CATALOG, type CatalogCode } from "./catalog";

// docs/SPEC.md section 4 is the source of truth for status and copy. This
// keeps the code from drifting away from it without anyone noticing.
const spec = readFileSync(
  path.join(import.meta.dirname, "../../../docs/SPEC.md"),
  "utf-8",
);

function specRow(
  code: string,
): { status: string; message: string } | undefined {
  const line = spec.split("\n").find((l) => l.startsWith(`| \`${code}\` |`));
  if (!line) return undefined;
  const cells = line.split("|").map((c) => c.trim());
  return { status: cells[2] ?? "", message: cells[3] ?? "" };
}

describe("ERROR_CATALOG", () => {
  const codes = Object.keys(ERROR_CATALOG) as CatalogCode[];

  it.each(codes)("%s matches docs/SPEC.md", (code) => {
    const row = specRow(code);
    expect(row, `${code} is missing from SPEC section 4`).toBeDefined();
    expect(row?.status).toBe(String(ERROR_CATALOG[code].status));
    expect(row?.message).toBe(ERROR_CATALOG[code].message);
  });

  it("has user-facing copy that is short and plain", () => {
    for (const code of codes) {
      const { message } = ERROR_CATALOG[code];
      expect(message.length).toBeLessThan(110);
      expect(message).toMatch(/[.?]$/);
    }
  });

  it("has an error status for every code", () => {
    for (const code of codes) {
      expect(ERROR_CATALOG[code].status).toBeGreaterThanOrEqual(400);
    }
  });
});
