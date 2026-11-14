import type { ResponseUsageWire, TranscriptionUsageWire } from "./events";

// Token counts for one session, summed across every response.done and
// transcription usage block. Pricing is linear in these counts, so summing
// first and pricing once gives the same cost as pricing each response.

export interface UsageTotals {
  responses: number;
  input: { text: number; audio: number; image: number };
  /** Subsets of `input`: tokens that hit the prompt cache. */
  cached: { text: number; audio: number; image: number };
  output: { text: number; audio: number };
  transcription: {
    events: number;
    inputTokens: number;
    outputTokens: number;
    seconds: number;
  };
}

export const EMPTY_USAGE: UsageTotals = {
  responses: 0,
  input: { text: 0, audio: 0, image: 0 },
  cached: { text: 0, audio: 0, image: 0 },
  output: { text: 0, audio: 0 },
  transcription: { events: 0, inputTokens: 0, outputTokens: 0, seconds: 0 },
};

const n = (v: number | undefined): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

export function addResponseUsage(
  totals: UsageTotals,
  usage: ResponseUsageWire | null | undefined,
): UsageTotals {
  if (!usage) return totals;
  const inDetails = usage.input_token_details;
  const input = {
    text: n(inDetails?.text_tokens),
    audio: n(inDetails?.audio_tokens),
    image: n(inDetails?.image_tokens),
  };
  // Without a modality split, treat the whole input as text rather than lose it.
  if (!input.text && !input.audio && !input.image) {
    input.text = n(usage.input_tokens);
  }
  const split = inDetails?.cached_tokens_details;
  // The reference defines cached as a subset of input per modality. When only
  // the total is given, assume text: the cached prefix is the instructions.
  const cached = split
    ? {
        text: n(split.text_tokens),
        audio: n(split.audio_tokens),
        image: n(split.image_tokens),
      }
    : { text: n(inDetails?.cached_tokens), audio: 0, image: 0 };
  const outDetails = usage.output_token_details;
  const output = {
    text: n(outDetails?.text_tokens),
    audio: n(outDetails?.audio_tokens),
  };
  if (!output.text && !output.audio) output.text = n(usage.output_tokens);

  return {
    ...totals,
    responses: totals.responses + 1,
    input: {
      text: totals.input.text + input.text,
      audio: totals.input.audio + input.audio,
      image: totals.input.image + input.image,
    },
    cached: {
      text: totals.cached.text + Math.min(cached.text, input.text),
      audio: totals.cached.audio + Math.min(cached.audio, input.audio),
      image: totals.cached.image + Math.min(cached.image, input.image),
    },
    output: {
      text: totals.output.text + output.text,
      audio: totals.output.audio + output.audio,
    },
  };
}

export function addTranscriptionUsage(
  totals: UsageTotals,
  usage: TranscriptionUsageWire | null | undefined,
): UsageTotals {
  if (!usage) return totals;
  const t = totals.transcription;
  const next =
    usage.type === "duration"
      ? { ...t, events: t.events + 1, seconds: t.seconds + n(usage.seconds) }
      : {
          ...t,
          events: t.events + 1,
          inputTokens: t.inputTokens + n(usage.input_tokens),
          outputTokens: t.outputTokens + n(usage.output_tokens),
        };
  return { ...totals, transcription: next };
}
