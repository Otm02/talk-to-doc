// USD per 1M tokens, from docs/reference/openai-realtime.md section 4
// (https://developers.openai.com/api/docs/pricing). Prices drift, so the
// fetch date is part of the data and shown next to every estimate.
export const PRICES_FETCHED = "2026-11-09";

interface Rate {
  input: number;
  cached: number;
}

export interface ModelPrices {
  text: Rate & { output: number };
  audio: Rate & { output: number };
  image: Rate;
}

export const PRICES_PER_MILLION = {
  "gpt-realtime-2.1": {
    text: { input: 4.0, cached: 0.4, output: 24.0 },
    audio: { input: 32.0, cached: 0.4, output: 64.0 },
    image: { input: 5.0, cached: 0.5 },
  },
  "gpt-realtime-2.1-mini": {
    text: { input: 0.6, cached: 0.06, output: 2.4 },
    audio: { input: 10.0, cached: 0.3, output: 20.0 },
    image: { input: 0.8, cached: 0.08 },
  },
} as const satisfies Record<string, ModelPrices>;

export type PricedModel = keyof typeof PRICES_PER_MILLION;

export function isPricedModel(model: string): model is PricedModel {
  return model in PRICES_PER_MILLION;
}

// gpt-4o-mini-transcribe, the model the session endpoint asks for (reference
// section 6). Reported either in tokens or in seconds, so both are priced.
export const TRANSCRIPTION_PRICES = {
  perMinute: 0.003,
  inputPerMillion: 1.25,
  outputPerMillion: 5.0,
} as const;
