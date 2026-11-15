import { describe, expect, it } from "vitest";
import { renderSummary, type CoverageSummary } from "./coverage-summary";

const counts = (covered: number, total: number) => ({ covered, total });
const file = (covered: number, total: number) => ({
  lines: counts(covered, total),
  statements: counts(covered, total),
  functions: counts(covered, total),
  branches: counts(covered, total),
});

const summary: CoverageSummary = {
  total: file(0, 0),
  "/repo/src/server/a.ts": file(95, 100),
  "/repo/src/server/b.ts": file(85, 100),
  "/repo/src/features/voice/realtime/r.ts": file(89, 100),
  "/repo/src/features/ingest/i.ts": file(50, 100),
};

describe("renderSummary", () => {
  const md = renderSummary(summary, "/repo");

  it("pools the files of an area instead of averaging their percentages", () => {
    // (95 + 85) / (100 + 100), not an average of anything else.
    expect(md).toMatch(/\| src\/server \| 90% \| ✅ 90\.0% \|/);
  });

  it("marks an area under its gate", () => {
    expect(md).toMatch(/realtime \| 90% \| ❌ 89\.0% \|/);
  });

  it("counts every file in the whole-app row, and ignores the report's own total", () => {
    // 95 + 85 + 89 + 50 = 319 of 400.
    expect(md).toMatch(/\| Whole app \| 80% \| ❌ 79\.8% \|/);
  });

  it("treats an area with nothing in it as fully covered", () => {
    const empty = renderSummary({ total: file(0, 0) }, "/repo");
    expect(empty).toMatch(/\| src\/server \| 90% \| ✅ 100\.0% \|/);
  });

  it("is a Markdown table GitHub can render", () => {
    const lines = md.trim().split("\n");
    expect(lines[0]).toBe("### Unit test coverage");
    const table = lines.filter((l) => l.startsWith("|"));
    expect(table).toHaveLength(5);
    expect(new Set(table.map((l) => l.split("|").length)).size).toBe(1);
  });
});
