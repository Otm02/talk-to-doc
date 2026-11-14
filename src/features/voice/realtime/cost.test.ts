import { describe, expect, it } from "vitest";
import { estimateCost, formatUsd } from "./cost";
import { isPricedModel } from "./prices";
import { EMPTY_USAGE, addResponseUsage, addTranscriptionUsage } from "./usage";

// The usage block from docs/reference/openai-realtime.md section 4.
const REFERENCE_USAGE = {
  total_tokens: 253,
  input_tokens: 132,
  output_tokens: 121,
  input_token_details: {
    text_tokens: 119,
    audio_tokens: 13,
    image_tokens: 0,
    cached_tokens: 64,
    cached_tokens_details: {
      text_tokens: 64,
      audio_tokens: 0,
      image_tokens: 0,
    },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 91 },
};

describe("estimateCost", () => {
  // Hand-priced, per 1M tokens:
  //  mini: text in 55 x 0.60 = 33.00   cached 64 x 0.06 = 3.84
  //        audio in 13 x 10  = 130.00
  //        text out 30 x 2.40 = 72.00  audio out 91 x 20 = 1820.00
  //        total 2058.84 / 1e6 = $0.00205884
  it("prices the reference usage block on mini", () => {
    const est = estimateCost(
      "gpt-realtime-2.1-mini",
      addResponseUsage(EMPTY_USAGE, REFERENCE_USAGE),
    );
    expect(est?.usd).toBeCloseTo(0.00205884, 10);
    expect(est?.lines.map((l) => [l.label, l.tokens])).toEqual([
      ["text in", 55],
      ["text in (cached)", 64],
      ["audio in", 13],
      ["text out", 30],
      ["audio out", 91],
    ]);
  });

  //  2.1: text in 55 x 4 = 220   cached 64 x 0.4 = 25.6   audio in 13 x 32 = 416
  //       text out 30 x 24 = 720   audio out 91 x 64 = 5824   total 7205.6 / 1e6
  it("prices the same block on gpt-realtime-2.1", () => {
    const est = estimateCost(
      "gpt-realtime-2.1",
      addResponseUsage(EMPTY_USAGE, REFERENCE_USAGE),
    );
    expect(est?.usd).toBeCloseTo(0.0072056, 10);
  });

  it("charges cached audio at the cached audio rate, not the input rate", () => {
    const usage = addResponseUsage(EMPTY_USAGE, {
      input_token_details: {
        audio_tokens: 1000,
        cached_tokens: 400,
        cached_tokens_details: { audio_tokens: 400 },
      },
    });
    // mini audio: 600 x 10 + 400 x 0.3 = 6120 / 1e6
    expect(estimateCost("gpt-realtime-2.1-mini", usage)?.usd).toBeCloseTo(
      0.00612,
      10,
    );
  });

  it("prices image input", () => {
    const usage = addResponseUsage(EMPTY_USAGE, {
      input_token_details: {
        image_tokens: 100,
        cached_tokens_details: { image_tokens: 40 },
      },
    });
    // mini image: 60 x 0.8 + 40 x 0.08 = 51.2 / 1e6
    expect(estimateCost("gpt-realtime-2.1-mini", usage)?.usd).toBeCloseTo(
      0.0000512,
      10,
    );
  });

  it("is the same whether it prices responses one by one or summed", () => {
    const once = addResponseUsage(EMPTY_USAGE, REFERENCE_USAGE);
    const twice = addResponseUsage(once, REFERENCE_USAGE);
    expect(twice.responses).toBe(2);
    const single = estimateCost("gpt-realtime-2.1-mini", once)?.usd ?? NaN;
    expect(estimateCost("gpt-realtime-2.1-mini", twice)?.usd).toBeCloseTo(
      single * 2,
      12,
    );
  });

  it("prices transcription by tokens and by duration", () => {
    const tokens = addTranscriptionUsage(EMPTY_USAGE, {
      type: "tokens",
      input_tokens: 40,
      output_tokens: 6,
    });
    // 40 x 1.25 + 6 x 5 = 80 / 1e6
    expect(estimateCost("gpt-realtime-2.1-mini", tokens)?.usd).toBeCloseTo(
      0.00008,
      10,
    );
    const seconds = addTranscriptionUsage(EMPTY_USAGE, {
      type: "duration",
      seconds: 30,
    });
    // 0.5 min x $0.003
    expect(estimateCost("gpt-realtime-2.1-mini", seconds)?.usd).toBeCloseTo(
      0.0015,
      10,
    );
  });

  it("returns null for a model it has no prices for", () => {
    expect(estimateCost("gpt-realtime-9", EMPTY_USAGE)).toBeNull();
    expect(isPricedModel("gpt-realtime-9")).toBe(false);
  });

  it("is zero with no lines before anything happened", () => {
    expect(estimateCost("gpt-realtime-2.1-mini", EMPTY_USAGE)).toEqual({
      usd: 0,
      lines: [],
      tokens: 0,
    });
  });
});

describe("usage accounting", () => {
  it("ignores a missing usage block", () => {
    expect(addResponseUsage(EMPTY_USAGE, undefined)).toBe(EMPTY_USAGE);
    expect(addResponseUsage(EMPTY_USAGE, null)).toBe(EMPTY_USAGE);
    expect(addTranscriptionUsage(EMPTY_USAGE, null)).toBe(EMPTY_USAGE);
  });

  it("falls back to the totals when there is no modality split", () => {
    const u = addResponseUsage(EMPTY_USAGE, {
      input_tokens: 50,
      output_tokens: 7,
    });
    expect(u.input.text).toBe(50);
    expect(u.output.text).toBe(7);
  });

  it("attributes a lone cached_tokens count to text, and never beyond the input", () => {
    const u = addResponseUsage(EMPTY_USAGE, {
      input_token_details: { text_tokens: 10, cached_tokens: 64 },
    });
    expect(u.cached.text).toBe(10);
  });

  it("ignores negative and non-finite counts", () => {
    const u = addResponseUsage(EMPTY_USAGE, {
      input_token_details: { text_tokens: -5, audio_tokens: Number.NaN },
      output_token_details: { text_tokens: 3 },
    });
    expect(u.input).toEqual({ text: 0, audio: 0, image: 0 });
    expect(u.output.text).toBe(3);
  });
});

describe("formatUsd", () => {
  it("shows four decimals for cents and three above ten cents", () => {
    expect(formatUsd(0.00205884)).toBe("$0.0021");
    expect(formatUsd(0.1234)).toBe("$0.123");
    expect(formatUsd(0)).toBe("$0.0000");
  });
});
