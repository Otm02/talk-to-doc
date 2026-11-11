import { describe, expect, it } from "vitest";
import {
  countVisibleChars,
  countWords,
  normalizePageText,
  pageMarker,
} from "./normalize";

describe("ligatures", () => {
  it.each([
    ["ﬀ", "ff"],
    ["ﬁ", "fi"],
    ["ﬂ", "fl"],
    ["ﬃ", "ffi"],
    ["ﬄ", "ffl"],
    ["ﬅ", "st"], // long s t
    ["ﬆ", "st"],
  ])("maps U+%s to its letters", (ligature, letters) => {
    expect(normalizePageText(`o${ligature}ce`)).toBe(`o${letters}ce`);
  });

  it("fixes a whole French sentence", () => {
    expect(normalizePageText("Le ﬁnancement oﬃciel du ﬂeuve")).toBe(
      "Le financement officiel du fleuve",
    );
  });
});

describe("presentation forms outside Latin", () => {
  it("folds Arabic presentation forms to base letters", () => {
    // U+FEE3 U+FEF4 U+FEE3 are isolated/medial forms of meem and yeh.
    expect(normalizePageText("ﻣﻴﻣ")).toBe("ميم");
  });

  it("folds the lam-alef ligature to two letters", () => {
    expect(normalizePageText("ﻻ")).toBe("لا");
  });
});

describe("text that must not change", () => {
  it.each([
    ["superscripts", "area is 5 m²"],
    ["fractions", "add ½ cup"],
    ["trademark", "Brand™"],
    ["full-width Latin", "ＡＢＣ"],
    ["ellipsis", "wait…"],
    ["accents", "Résumé de l’œuvre"],
    ["CJK", "日本語のテキスト"],
    ["Cyrillic", "Привет, мир"],
    ["Devanagari", "नमस्ते दुनिया"],
    ["Arabic base letters", "مرحبا بالعالم"],
  ])("leaves %s alone", (_name, text) => {
    expect(normalizePageText(text)).toBe(text);
  });
});

describe("control and invisible characters", () => {
  it("strips null bytes and C0 and C1 controls", () => {
    expect(
      normalizePageText("a\u0000b\u0007c\u001Fd\u007Fe\u0085f\u009Fg"),
    ).toBe("abcdefg");
  });

  it("strips the soft hyphen and the BOM", () => {
    expect(normalizePageText("exam­ple﻿ text")).toBe("example text");
  });

  it("keeps tabs, newlines and form feeds as whitespace", () => {
    expect(normalizePageText("a\tb\u000Bc\u000Cd")).toBe("a b c d");
  });

  it("turns CR, CRLF and Unicode line separators into newlines", () => {
    expect(normalizePageText("a\r\nb\rc d e")).toBe("a\nb\nc\nd\ne");
  });
});

describe("hyphenation across line breaks", () => {
  it("joins a word split before a lowercase letter", () => {
    expect(normalizePageText("The informa-\ntion was trans-\nmitted")).toBe(
      "The information was transmitted",
    );
  });

  it("joins when the line has trailing and leading spaces", () => {
    expect(normalizePageText("informa-  \n  tion")).toBe("information");
  });

  it("joins across the Unicode hyphen too", () => {
    expect(normalizePageText("informa‐\ntion")).toBe("information");
  });

  it("joins accented lowercase letters", () => {
    expect(normalizePageText("développe-\nment")).toBe("développement");
  });

  it("keeps the hyphen before a capital letter", () => {
    expect(normalizePageText("by Jean-\nPierre")).toBe("by Jean-\nPierre");
  });

  it("keeps the hyphen before a digit", () => {
    expect(normalizePageText("in 2024-\n05")).toBe("in 2024-\n05");
  });

  it("keeps a hyphen inside a line", () => {
    expect(normalizePageText("a well-known fact")).toBe("a well-known fact");
  });

  it("keeps a lone dash that is not part of a word", () => {
    expect(normalizePageText("item -\nnext")).toBe("item -\nnext");
  });

  it("does not join across a paragraph break", () => {
    expect(normalizePageText("end of para-\n\nnext para")).toBe(
      "end of para-\n\nnext para",
    );
  });
});

describe("whitespace and paragraphs", () => {
  it("collapses runs of spaces", () => {
    expect(normalizePageText("a    b    c")).toBe("a b c");
  });

  it("trims spaces around line breaks", () => {
    expect(normalizePageText("a  \n  b")).toBe("a\nb");
  });

  it("keeps a single line break", () => {
    expect(normalizePageText("line one\nline two")).toBe("line one\nline two");
  });

  it("keeps a paragraph break as exactly one blank line", () => {
    expect(normalizePageText("para one\n\npara two")).toBe(
      "para one\n\npara two",
    );
    expect(normalizePageText("para one\n\n\n\n\npara two")).toBe(
      "para one\n\npara two",
    );
    expect(normalizePageText("para one\n \n \n\npara two")).toBe(
      "para one\n\npara two",
    );
  });

  it("trims the ends", () => {
    expect(normalizePageText("\n\n  hello  \n\n")).toBe("hello");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizePageText(" \n\t  \n")).toBe("");
    expect(normalizePageText("")).toBe("");
  });

  it("is idempotent", () => {
    const once = normalizePageText("oﬃce  ­  trans-\nmitted\n\n\n\nend");
    expect(normalizePageText(once)).toBe(once);
  });
});

describe("helpers", () => {
  it("formats the page marker", () => {
    expect(pageMarker(7)).toBe("--- Page 7 ---");
  });

  it("counts visible characters without whitespace", () => {
    expect(countVisibleChars(" a b\n\tc ")).toBe(3);
    expect(countVisibleChars("")).toBe(0);
    expect(countVisibleChars("日本 語")).toBe(3);
  });

  it("counts words by whitespace", () => {
    expect(countWords("one two\nthree  four")).toBe(4);
    expect(countWords("   ")).toBe(0);
  });
});
