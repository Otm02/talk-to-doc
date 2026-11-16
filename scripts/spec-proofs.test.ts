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

// Not only test files: any `src/...`, `test/...`, `e2e/...` or `scripts/...`
// path in backticks is a claim that the file exists. Directories (trailing
// slash), `*` globs and a `:line` suffix are allowed. A path with `<` is a
// template, not a claim.
const PATH_CLAIM = /`((?:src|test|e2e|scripts)\/[^`\s<>]*)`/g;
const dirs = new Set(
  files.flatMap((f) => {
    const parts = f.split("/");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  }),
);

/** `a/{b,c}.pdf` is two paths. One level of braces is all the docs use. */
function expandBraces(claim: string): string[] {
  const m = /^(.*)\{([^{}]*)\}(.*)$/.exec(claim);
  if (!m) return [claim];
  const [, head = "", list = "", tail = ""] = m;
  return list.split(",").flatMap((alt) => expandBraces(`${head}${alt}${tail}`));
}

export function claimedPaths(markdown: string): string[] {
  return [
    ...new Set(
      [...markdown.matchAll(PATH_CLAIM)].flatMap((m) =>
        expandBraces((m[1] ?? "").replace(/:\d+(?:-\d+)?$/, "")),
      ),
    ),
  ];
}

export function pathExists(claim: string): boolean {
  if (claim.includes("*")) {
    const re = globToRegExp(claim.replace(/\/$/, ""));
    return [...files, ...dirs].some((f) => re.test(f));
  }
  if (claim.endsWith("/")) return dirs.has(claim.slice(0, -1));
  return files.includes(claim) || dirs.has(claim);
}

// The same rule for the docs that describe the code as it is (PLAN.md is
// left out: it records what was planned, including names that changed).
describe.each(["ARCHITECTURE", "DEPLOY", "SECURITY"])(
  "docs/%s.md paths",
  (name) => {
    it("points every src/, test/, e2e/ and scripts/ path at something that exists", () => {
      const text = readFileSync(path.join(root, `docs/${name}.md`), "utf8");
      const missing = claimedPaths(text)
        // A pattern such as src/app/**/page.tsx is a rule, not a file.
        .filter((p) => !p.includes("**"))
        .filter((p) => !pathExists(p));
      expect(missing).toEqual([]);
    });
  },
);

describe("docs/SPEC.md proofs", () => {
  it("expands braces, so a claim of several files is checked file by file", () => {
    expect(
      claimedPaths("`test/fixtures/pdf/{cjk,arabic}.pdf` and `src/a.ts:12`"),
    ).toEqual([
      "test/fixtures/pdf/cjk.pdf",
      "test/fixtures/pdf/arabic.pdf",
      "src/a.ts",
    ]);
    expect(pathExists("test/fixtures/pdf/cjk.pdf")).toBe(true);
    expect(pathExists("test/fixtures/pdf/nope.pdf")).toBe(false);
    expect(pathExists("src/server/youtube")).toBe(false);
    expect(pathExists("src/server/ingest/youtube/")).toBe(true);
  });

  it("names a good number of paths (the parser is not matching nothing)", () => {
    expect(claimedPaths(spec).length).toBeGreaterThan(90);
  });

  it("points every src/, test/, e2e/ and scripts/ path at something that exists", () => {
    expect(claimedPaths(spec).filter((p) => !pathExists(p))).toEqual([]);
  });

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
