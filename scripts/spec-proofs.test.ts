import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// docs/SPEC.md names a test file as the proof of a requirement. A name that
// no longer exists proves nothing, so this fails when a path in the SPEC does
// not point at a real file, when a bare file name is used where a path is
// needed, or when a Playwright test title quoted in section 2.6 has been
// renamed away.

const root = path.join(import.meta.dirname, "..");
const spec = readFileSync(path.join(root, "docs/SPEC.md"), "utf8");

function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(
    (e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        return e.name === "node_modules" || e.name.startsWith(".")
          ? []
          : walk(rel);
      }
      return [rel];
    },
  );
}
const files = ["src", "e2e", "scripts", "test"].flatMap(walk);

const TEST_FILE = /\.(test|spec)\.tsx?$/;
const proofs = [...spec.matchAll(/`([^`\n]*\.(?:test|spec)\.tsx?)`/g)]
  .map((m) => m[1] ?? "")
  .filter((t) => !t.startsWith("*") && t !== "");

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${body}$`);
}

describe("docs/SPEC.md proofs", () => {
  it("names a good number of test files (the parser is not matching nothing)", () => {
    expect(new Set(proofs).size).toBeGreaterThan(60);
  });

  it("gives every test file as a path from the repo root, never a bare name", () => {
    const bare = proofs.filter((p) => !p.includes("/"));
    expect(bare).toEqual([]);
  });

  it("points every test file at a file that exists", () => {
    const missing = [...new Set(proofs)].filter((p) =>
      p.includes("*")
        ? !files.some((f) => globToRegExp(p).test(f))
        : !files.includes(p),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the e2e map in section 2.6 true: each file has the quoted test title", () => {
    const start = spec.indexOf("### 2.6");
    const end = spec.indexOf("\n## ", start);
    const rows = spec
      .slice(start, end)
      .split("\n")
      .filter((l) => l.startsWith("| ") && l.includes("`e2e/"));
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const row of rows) {
      const file = /`(e2e\/[^`]+)`/.exec(row)?.[1];
      const title = /"([^"]+)"\s*\|?\s*$/.exec(row)?.[1];
      expect(file, row).toBeTruthy();
      expect(title, row).toBeTruthy();
      expect(TEST_FILE.test(file ?? ""), row).toBe(true);
      const source = readFileSync(path.join(root, file ?? ""), "utf8");
      expect(source, `${file} lacks "${title}"`).toContain(title ?? "");
    }
  });
});
