/**
 * Turns coverage/coverage-summary.json (written by `pnpm test:coverage`) into
 * a Markdown table for the CI job summary:
 *
 *   node scripts/coverage-summary.ts >> "$GITHUB_STEP_SUMMARY"
 *
 * The three rows are the three gates in vitest.config.mts. The numbers here
 * are only a report; the gate itself is the threshold in that file, which
 * fails the test step. Node 24 runs this file directly, so keep to erasable
 * TypeScript syntax.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METRICS = ["lines", "statements", "functions", "branches"] as const;
type Metric = (typeof METRICS)[number];
type Counts = { total: number; covered: number };
type FileSummary = Record<Metric, Counts>;
export type CoverageSummary = Record<string, FileSummary>;

/** Where each row looks, and the bar vitest.config.mts holds it to. */
export const AREAS: readonly { name: string; prefix: string; gate: number }[] =
  [
    { name: "Whole app", prefix: "", gate: 80 },
    { name: "src/server", prefix: "src/server/", gate: 90 },
    {
      name: "src/features/voice/realtime",
      prefix: "src/features/voice/realtime/",
      gate: 90,
    },
  ];

function pct(c: Counts): number {
  // Nothing to cover counts as covered, as the reporters do.
  return c.total === 0 ? 100 : (c.covered / c.total) * 100;
}

export function renderSummary(summary: CoverageSummary, root: string): string {
  const files = Object.entries(summary)
    .filter(([name]) => name !== "total")
    .map(
      ([name, v]) => [relative(root, name).replaceAll("\\", "/"), v] as const,
    );

  const rows = AREAS.map((area) => {
    const inArea = files.filter(([name]) => name.startsWith(area.prefix));
    const cells = METRICS.map((m) => {
      const sum = inArea.reduce<Counts>(
        (acc, [, f]) => ({
          total: acc.total + f[m].total,
          covered: acc.covered + f[m].covered,
        }),
        { total: 0, covered: 0 },
      );
      const value = pct(sum);
      return `${value >= area.gate ? "✅" : "❌"} ${value.toFixed(1)}%`;
    });
    return `| ${area.name} | ${area.gate}% | ${cells.join(" | ")} |`;
  });

  return [
    "### Unit test coverage",
    "",
    `| Area | Gate | ${METRICS.join(" | ")} |`,
    `|---|---|${METRICS.map(() => "---").join("|")}|`,
    ...rows,
    "",
  ].join("\n");
}

function main(): void {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const file = resolve(root, "coverage/coverage-summary.json");
  if (!existsSync(file)) {
    console.log("### Unit test coverage\n\nNo coverage report was written.\n");
    return;
  }
  const summary: CoverageSummary = JSON.parse(readFileSync(file, "utf8"));
  console.log(renderSummary(summary, root));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
