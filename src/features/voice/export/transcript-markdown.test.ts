import { describe, expect, it } from "vitest";
import type { ItemStatus, TranscriptItem } from "../realtime/state";
import {
  buildTranscriptMarkdown,
  localDate,
  slugify,
  transcriptFilename,
} from "./transcript-markdown";

let seq = 0;
function item(
  role: "user" | "assistant",
  text: string,
  status: ItemStatus = "done",
): TranscriptItem {
  seq += 1;
  return {
    id: `i${seq}`,
    role,
    source: role === "user" ? "voice" : "text",
    text,
    status,
    responseId: null,
    prev: null,
    epoch: 1,
    arrival: seq,
  };
}

// Local time on purpose: the file is dated by the user's own calendar day.
const DATE = new Date(2026, 10, 14, 23, 30);

describe("buildTranscriptMarkdown", () => {
  it("writes the header and every turn (snapshot)", () => {
    const md = buildTranscriptMarkdown({
      title: "Annual report 2025",
      source: "annual-report-2025.pdf",
      date: DATE,
      model: "gpt-realtime-2.1-mini",
      items: [
        item("user", "What was revenue?"),
        item("assistant", "Revenue grew twelve percent last year, see page 2."),
        item("user", "Summarise the outlook."),
        item("assistant", "The outlook covers three", "interrupted"),
        item("user", "Just the margins."),
        item("assistant", "Margins were forty percent."),
      ],
    });
    expect(md).toMatchInlineSnapshot(`
      "# Annual report 2025

      - Source: annual-report-2025.pdf
      - Date: 2026-11-14
      - Model: gpt-realtime-2.1-mini

      **You:** What was revenue?

      **Assistant:** Revenue grew twelve percent last year, see page 2.

      **You:** Summarise the outlook.

      **Assistant:** The outlook covers three *(interrupted)*

      **You:** Just the margins.

      **Assistant:** Margins were forty percent.
      "
    `);
  });

  it("uses the URL as the source for a video, and says when the model is unknown", () => {
    const md = buildTranscriptMarkdown({
      title: "A talk",
      source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      date: DATE,
      model: null,
      items: [item("user", "Hi")],
    });
    expect(md).toContain(
      "- Source: https://www.youtube.com/watch?v=dQw4w9WgXcQ\n",
    );
    expect(md).toContain("- Model: unknown\n");
  });

  it("marks an interrupted reply and drops one that never said a word", () => {
    const md = buildTranscriptMarkdown({
      title: "T",
      source: "t.pdf",
      date: DATE,
      model: "m",
      items: [
        item("assistant", "Half an ans", "interrupted"),
        item("assistant", "", "interrupted"),
      ],
    });
    expect(md).toContain("**Assistant:** Half an ans *(interrupted)*\n");
    expect(md.match(/\*\*Assistant:\*\*/g)).toHaveLength(1);
  });

  it("keeps what is on screen for turns still in flight, and skips empty ones", () => {
    const md = buildTranscriptMarkdown({
      title: "T",
      source: "t.pdf",
      date: DATE,
      model: "m",
      items: [
        item("user", "", "transcribing"),
        item("user", "typed and on its way", "sending"),
        item("assistant", "so far", "streaming"),
        item("assistant", "   ", "done"),
      ],
    });
    expect(md).toContain("**You:** typed and on its way\n");
    expect(md).toContain("**Assistant:** so far\n");
    expect(md.match(/\*\*You:\*\*/g)).toHaveLength(1);
    expect(md.match(/\*\*Assistant:\*\*/g)).toHaveLength(1);
  });

  it("keeps a spoken turn whose words were lost, and drops a message that was never sent", () => {
    const md = buildTranscriptMarkdown({
      title: "T",
      source: "t.pdf",
      date: DATE,
      model: "m",
      items: [
        item("user", "", "transcriptionFailed"),
        item("user", "did not go out", "sendFailed"),
      ],
    });
    expect(md).toContain("**You:** *(not transcribed)*\n");
    expect(md).not.toContain("did not go out");
  });

  it("says so when there is nothing to export", () => {
    const md = buildTranscriptMarkdown({
      title: "T",
      source: "t.pdf",
      date: DATE,
      model: "m",
      items: [],
    });
    expect(md.endsWith("*No messages.*\n")).toBe(true);
  });

  it("keeps the title on one line and a turn in one paragraph", () => {
    const md = buildTranscriptMarkdown({
      title: "  Line one\nLine two\t ",
      source: " a\nb.pdf ",
      date: DATE,
      model: "m",
      items: [item("assistant", "First line.\n\n\n  Second line.  \r\nThird.")],
    });
    expect(md.startsWith("# Line one Line two\n")).toBe(true);
    expect(md).toContain("- Source: a b.pdf\n");
    expect(md).toContain("**Assistant:** First line.\nSecond line.\nThird.\n");
    expect(
      buildTranscriptMarkdown({
        title: " ",
        source: "",
        date: DATE,
        model: "m",
        items: [],
      }),
    ).toContain("# Untitled\n\n- Source: unknown\n");
  });

  it("ends with exactly one newline", () => {
    const md = buildTranscriptMarkdown({
      title: "T",
      source: "t.pdf",
      date: DATE,
      model: "m",
      items: [item("user", "Hi")],
    });
    expect(md.endsWith("**You:** Hi\n")).toBe(true);
  });
});

describe("untrusted text in the export", () => {
  const md = (items: TranscriptItem[], title = "T", source = "t.pdf") =>
    buildTranscriptMarkdown({ title, source, date: DATE, model: "m", items });

  it("makes raw HTML and autolinks literal, in turns, the title and the source", () => {
    const out = md(
      [
        item(
          "assistant",
          "see <img src=x onerror=alert(1)> and <https://evil.example>",
        ),
      ],
      "Report <script>alert(1)</script>",
      "<b>x</b>.pdf",
    );
    expect(out).toContain("# Report \\<script\\>alert(1)\\</script\\>");
    expect(out).toContain("- Source: \\<b\\>x\\</b\\>.pdf");
    expect(out).toContain(
      "see \\<img src=x onerror=alert(1)\\> and \\<https://evil.example\\>",
    );
    expect(out).not.toMatch(/(^|[^\\])</);
  });

  it("defuses an inline link target", () => {
    const out = md([item("assistant", "[click](javascript:alert(1))")]);
    expect(out).toContain("[click]\\(javascript:alert(1))");
  });

  it.each([
    ["# a heading", "\\# a heading"],
    ["> a quote", "\\> a quote"],
    ["- a list", "\\- a list"],
    ["+ a list", "\\+ a list"],
    ["* a list", "\\* a list"],
    ["1. a list", "1\\. a list"],
    ["2) a list", "2\\) a list"],
    ["---", "\\---"],
    ["===", "\\==="],
    ["```js", "\\```js"],
    ["| a | b |", "\\| a | b |"],
    ["**Assistant:** forged", "\\**Assistant:** forged"],
    ["[x]: javascript:alert(1)", "\\[x]: javascript:alert(1)"],
  ])("a line that starts with %j cannot start a block", (line, escaped) => {
    const out = md([item("assistant", `first\n${line}`)]);
    expect(out).toContain(`**Assistant:** first\n${escaped}\n`);
  });

  it("leaves ordinary prose, timestamps and page references untouched", () => {
    const text =
      "Revenue is on page 2 (see [04:05]); margins were 40% - up 3.5x.";
    expect(md([item("assistant", text)])).toContain(`**Assistant:** ${text}\n`);
  });
});

describe("transcriptFilename", () => {
  it("is <title-slug>-<YYYY-MM-DD>.md", () => {
    expect(transcriptFilename("Annual report 2025", DATE)).toBe(
      "annual-report-2025-2026-11-14.md",
    );
  });

  it("dates the file by the local day, zero-padded", () => {
    expect(localDate(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
    expect(localDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it.each([
    ["Résumé — Q3 (final).pdf", "resume-q3-final-pdf"],
    ["  ---Hello,   World!---  ", "hello-world"],
    ["Ünïcödé Ça va?", "unicode-ca-va"],
    ["日本語のタイトル", "日本語のタイトル"],
    ["تقرير سنوي", "تقرير-سنوي"],
    // The vowel signs belong to the letters; losing them makes another word.
    ["हिन्दी रिपोर्ट", "हिन्दी-रिपोर्ट"],
    ["தமிழ் அறிக்கை", "தமிழ்-அறிக்கை"],
    ["한국어 보고서", "한국어-보고서"],
    ["ไทย รายงาน", "ไทย-รายงาน"],
    ["ガイド パンフレット", "ガイド-パンフレット"],
    ['a/b\\c:d*e?f"g<h>i|j', "a-b-c-d-e-f-g-h-i-j"],
    ["", "transcript"],
    ["!!! ???", "transcript"],
  ])("slugifies %j to %s", (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it("caps a long title at 60 characters without a trailing dash", () => {
    const slug = slugify(`${"word ".repeat(11)}tail and some more words here`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("word-word")).toBe(true);
    // Exactly at a dash boundary: the dash is trimmed, not kept.
    expect(slugify(`${"a".repeat(59)} b`)).toBe("a".repeat(59));
  });

  it("cuts by code point, so an emoji or other astral character is never split", () => {
    const slug = slugify("𝒜".repeat(70));
    expect(Array.from(slug)).toHaveLength(60);
    expect(slug).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/);
  });

  it("never produces a path or an extension trick", () => {
    const name = transcriptFilename("../../etc/passwd .exe", DATE);
    expect(name).toBe("etc-passwd-exe-2026-11-14.md");
    expect(name).not.toMatch(/[\\/]|\.\./);
  });
});
