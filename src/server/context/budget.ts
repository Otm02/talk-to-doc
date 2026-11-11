import "server-only";
import {
  countTokens as countO200k,
  decode,
  encode,
} from "gpt-tokenizer/encoding/o200k_base";

// The only reduction the product allows is this cap (CLAUDE.md): the document
// is cut, never summarized or chunked. The preview still shows everything.

// Document text is untrusted. By default the tokenizer throws on strings like
// "<|endoftext|>", which would let a PDF crash ingestion; count them as text.
const AS_PLAIN_TEXT = { disallowedSpecial: new Set<string>() };

export function countTokens(text: string): number {
  return countO200k(text, AS_PLAIN_TEXT);
}

export interface CappedText {
  text: string;
  tokens: number;
  truncated: boolean;
}

const PARAGRAPH_BREAK = /\n{2,}/;

/**
 * Keeps whole paragraphs, in order, while they fit in `budgetTokens`. If even
 * the first paragraph is too big, falls back to a hard cut at a token
 * boundary so the budget always holds. `totalTokens` skips a recount when the
 * caller already has it.
 */
export function capToTokenBudget(
  text: string,
  budgetTokens: number,
  totalTokens: number = countTokens(text),
): CappedText {
  if (totalTokens <= budgetTokens) {
    return { text, tokens: totalTokens, truncated: false };
  }

  const paragraphs = text.split(PARAGRAPH_BREAK);
  // Summing per-paragraph counts is cheaper than recounting a growing prefix.
  // It can be off by a token at a join, so the result is verified below.
  const kept: string[] = [];
  let used = 0;
  for (const paragraph of paragraphs) {
    const cost = countTokens(paragraph) + (kept.length > 0 ? 1 : 0);
    if (used + cost > budgetTokens) break;
    kept.push(paragraph);
    used += cost;
  }

  while (kept.length > 0) {
    const candidate = kept.join("\n\n");
    const tokens = countTokens(candidate);
    if (tokens <= budgetTokens) {
      return { text: candidate, tokens, truncated: true };
    }
    kept.pop();
  }

  return hardCut(text, budgetTokens);
}

function hardCut(text: string, budgetTokens: number): CappedText {
  // A token is at least one character, so this prefix has enough tokens and we
  // avoid encoding a multi-megabyte paragraph just to keep a few thousand.
  const prefix = text.slice(0, budgetTokens * 8);
  const tokens = encode(prefix, AS_PLAIN_TEXT).slice(0, budgetTokens);
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  const cut = decode(tokens).replace(/�+$/u, "");
  return { text: cut, tokens: countTokens(cut), truncated: true };
}
