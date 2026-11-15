// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, downloadMarkdown } from "./export-actions";
import { buildTranscriptMarkdown } from "./transcript-markdown";

// Privacy: the exported transcript is built in the browser and never sent to
// the server. These pin both halves: no module on the export path can make a
// network request, and running the export makes none.

const SRC = path.join(import.meta.dirname, "../../..");
const EXPORT_PATH = [
  ...readdirSync(import.meta.dirname)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
    .map((f) => path.join(import.meta.dirname, f)),
  path.join(SRC, "lib/download.ts"),
  path.join(SRC, "features/voice/ui/export-buttons.tsx"),
];

const NETWORK =
  /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|["'`]\/api\//;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("transcript export stays in the browser", () => {
  it("has files to check", () => {
    expect(EXPORT_PATH.length).toBeGreaterThanOrEqual(5);
  });

  it.each(EXPORT_PATH.map((f) => [path.relative(SRC, f), f]))(
    "%s makes no network request",
    (_name, file) => {
      expect(readFileSync(String(file), "utf-8")).not.toMatch(NETWORK);
    },
  );

  it("builds, copies and downloads without touching the network", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    vi.stubGlobal("XMLHttpRequest", network);
    const markdown = buildTranscriptMarkdown({
      title: "Quarterly Report",
      source: "report.pdf",
      date: new Date(Date.UTC(2026, 10, 15)),
      model: "gpt-realtime-2.1-mini",
      items: [],
    });
    expect(markdown).toContain("# Quarterly Report");

    // jsdom has no Blob URLs; a stand-in makes the download path run.
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => undefined,
    });
    vi.useFakeTimers();
    await copyText(markdown, {
      clipboard: { writeText: async () => undefined },
    });
    downloadMarkdown("t.md", markdown);

    expect(network).not.toHaveBeenCalled();
  });
});
