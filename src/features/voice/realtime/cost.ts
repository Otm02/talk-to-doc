import {
  PRICES_PER_MILLION,
  TRANSCRIPTION_PRICES,
  isPricedModel,
} from "./prices";
import type { UsageTotals } from "./usage";

// Dev-only estimate of what a session cost, from the usage blocks the server
// already sends us. Nothing here is reported anywhere. Formula (reference
// section 4): cached tokens are a subset of input, so
//   cost = sum over modality of (in - cached) * in_price + cached * cached_price
//        + sum over modality of out * out_price, all divided by 1e6.

export interface CostLine {
  label: string;
  tokens: number;
  usd: number;
}

export interface CostEstimate {
  usd: number;
  lines: CostLine[];
  /** Total tokens across every line, transcription included. */
  tokens: number;
}

const per = (tokens: number, pricePerMillion: number) =>
  (tokens * pricePerMillion) / 1_000_000;

/** null when the model has no price table, so the UI says "n/a" not "$0". */
export function estimateCost(
  model: string,
  usage: UsageTotals,
): CostEstimate | null {
  if (!isPricedModel(model)) return null;
  const p = PRICES_PER_MILLION[model];
  const lines: CostLine[] = [];
  const add = (label: string, tokens: number, usd: number) => {
    if (tokens > 0 || usd > 0) lines.push({ label, tokens, usd });
  };

  for (const mod of ["text", "audio", "image"] as const) {
    const total = usage.input[mod];
    const cached = Math.min(usage.cached[mod], total);
    add(`${mod} in`, total - cached, per(total - cached, p[mod].input));
    add(`${mod} in (cached)`, cached, per(cached, p[mod].cached));
  }
  add("text out", usage.output.text, per(usage.output.text, p.text.output));
  add("audio out", usage.output.audio, per(usage.output.audio, p.audio.output));

  const t = usage.transcription;
  add(
    "transcription",
    t.inputTokens + t.outputTokens,
    per(t.inputTokens, TRANSCRIPTION_PRICES.inputPerMillion) +
      per(t.outputTokens, TRANSCRIPTION_PRICES.outputPerMillion) +
      (t.seconds / 60) * TRANSCRIPTION_PRICES.perMinute,
  );

  return {
    usd: lines.reduce((sum, l) => sum + l.usd, 0),
    lines,
    tokens: lines.reduce((sum, l) => sum + l.tokens, 0),
  };
}

export function formatUsd(usd: number): string {
  // Sessions cost cents or less; show enough digits to see a single turn.
  return `$${usd.toFixed(usd < 0.1 ? 4 : 3)}`;
}
