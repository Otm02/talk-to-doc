import "server-only";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Injected so tests can move time without sleeping. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface DocumentStore {
  put(id: string, doc: JsonValue, ttlMs: number): Promise<void>;
  /** null when missing or expired. */
  get(id: string): Promise<JsonValue | null>;
  delete(id: string): Promise<void>;
}

export interface RateRule {
  max: number;
  windowMs: number;
}

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Sliding window per key. Counts this call whether or not it is allowed only when allowed. */
  limit(key: string, rule: RateRule): Promise<RateResult>;
}

export interface UsageTotals {
  todaySpendUsd: number;
  totalSpendUsd: number;
  todaySessions: number;
  totalSessions: number;
}

export interface UsageLedger {
  addSpend(usd: number): Promise<void>;
  addSession(): Promise<void>;
  totals(): Promise<UsageTotals>;
}

export interface StateAdapters {
  documents: DocumentStore;
  rateLimiter: RateLimiter;
  ledger: UsageLedger;
}

/** UTC day key, e.g. 2026-11-09. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
