import { describe, expect, it } from "vitest";
import { capToTokenBudget, countTokens } from "./budget";

/** Roughly `n` tokens of distinct-ish words, so counts are stable. */
const words = (n: number, tag = "w") =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

describe("countTokens", () => {
  it("counts with o200k_base", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBe(2);
  });

  it("treats special-token text as plain text instead of throwing", () => {
    expect(() => countTokens("hello <|endoftext|> world")).not.toThrow();
    expect(countTokens("<|endoftext|>")).toBeGreaterThan(1);
  });
});

describe("capToTokenBudget", () => {
  it("returns the text untouched when it fits", () => {
    const text = "short\n\ntext";
    expect(capToTokenBudget(text, 1000)).toEqual({
      text,
      tokens: countTokens(text),
      truncated: false,
    });
  });

  it("accepts text of exactly the budget", () => {
    const text = "one two three";
    const exact = countTokens(text);
    expect(capToTokenBudget(text, exact).truncated).toBe(false);
    expect(capToTokenBudget(text, exact - 1).truncated).toBe(true);
  });

  it("cuts on a paragraph boundary and stays within budget", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      words(100, `p${i}_`),
    );
    const text = paragraphs.join("\n\n");
    const budget = 1000;
    const result = capToTokenBudget(text, budget);

    expect(result.truncated).toBe(true);
    expect(result.tokens).toBeLessThanOrEqual(budget);
    expect(result.tokens).toBe(countTokens(result.text));
    // Whole paragraphs only, in order, with nothing half-cut.
    const kept = result.text.split("\n\n");
    expect(kept).toEqual(paragraphs.slice(0, kept.length));
    // And it used the budget well: the next paragraph really did not fit.
    const next = paragraphs[kept.length] ?? "";
    expect(countTokens(`${result.text}\n\n${next}`)).toBeGreaterThan(budget);
  });

  it("never cuts a page marker away from its text", () => {
    const pages = Array.from(
      { length: 30 },
      (_, i) => `--- Page ${i + 1} ---\n${words(80, `q${i}_`)}`,
    );
    const result = capToTokenBudget(pages.join("\n\n"), 800);
    const lastPage = result.text.split("\n\n").at(-1) ?? "";
    expect(lastPage).toMatch(/^--- Page \d+ ---\nq\d+_0 /);
  });

  it("falls back to a token-boundary cut when one paragraph is over budget", () => {
    const text = words(5000); // a single paragraph
    const result = capToTokenBudget(text, 1000);
    expect(result.truncated).toBe(true);
    expect(result.tokens).toBeLessThanOrEqual(1000);
    expect(result.tokens).toBeGreaterThan(900);
    expect(text.startsWith(result.text)).toBe(true);
  });

  it("does not leave a broken character at a hard cut", () => {
    const text = "😀".repeat(3000);
    const result = capToTokenBudget(text, 1000);
    expect(result.text).not.toContain("\uFFFD");
    expect(result.tokens).toBeLessThanOrEqual(1000);
  });

  it("handles an empty document", () => {
    expect(capToTokenBudget("", 1000)).toEqual({
      text: "",
      tokens: 0,
      truncated: false,
    });
  });

  it("copes with a document made of special-token strings", () => {
    const text = "<|endoftext|> ".repeat(2000);
    const result = capToTokenBudget(text, 1000);
    expect(result.tokens).toBeLessThanOrEqual(1000);
  });

  it("trusts a precomputed total instead of recounting", () => {
    const text = words(50);
    expect(capToTokenBudget(text, 10_000, 5).tokens).toBe(5);
  });
});
