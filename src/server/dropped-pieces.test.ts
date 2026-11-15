import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The budget design is OpenAI's hard limit plus a few cheap guards. A dollar
// ledger, a spend limit in dollars, an admin token and a usage endpoint were
// tried and dropped; this keeps them from creeping back, in code or in docs.
// The names are assembled here so this file does not contain them itself.
const DROPPED = [
  ["Usage", "Ledger"].join(""),
  ["DAILY_SPEND", "LIMIT_USD"].join("_"),
  ["ADMIN", "TOKEN"].join("_"),
  ["/api", "usage"].join("/"),
  // Variants of the same ideas under other names.
  ["SPEND", "LIMIT"].join("_"),
  ["/api", "admin"].join("/"),
];

const ROOT = path.join(import.meta.dirname, "../..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".private",
  "coverage",
  "playwright-report",
  "test-results",
  ".vercel",
]);
const TEXT_FILE =
  /\.(?:ts|tsx|mts|js|mjs|json|md|yml|yaml|css|html|txt|example)$|\/\.env\.example$/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (TEXT_FILE.test(full) && name !== "pnpm-lock.yaml") yield full;
  }
}

describe("dropped budget pieces", () => {
  it("are not named anywhere in code, config or docs", () => {
    const hits: string[] = [];
    for (const file of files(ROOT)) {
      const text = readFileSync(file, "utf-8");
      for (const name of DROPPED) {
        if (text.includes(name)) {
          hits.push(`${path.relative(ROOT, file)}: ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("has no usage route", () => {
    expect(existsSync(path.join(ROOT, "src", "app", "api", "usage"))).toBe(
      false,
    );
  });

  it("scans something (the walk itself works)", () => {
    const seen = [...files(ROOT)].map((f) => path.relative(ROOT, f));
    expect(seen).toContain("docs/SPEC.md");
    expect(seen).toContain("src/server/env.ts");
    expect(seen).toContain(".env.example");
  });
});
