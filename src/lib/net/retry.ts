import { sleep } from "./timeout";

export interface RetryOptions {
  /** Only errors this accepts are retried; anything else is thrown at once. */
  retryable(error: unknown): boolean;
  /** Wait before the single retry, before jitter. Default 1 s. */
  baseMs?: number;
  signal?: AbortSignal;
  /** Test seam: 0..1. */
  random?: () => number;
}

/** base ± 25%, so a crowd of clients that failed together does not retry together. */
export function jitter(
  baseMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(baseMs * (0.75 + random() * 0.5));
}

/**
 * Runs `fn`, and once more after a short wait if it failed with an error the
 * caller calls retryable. One retry, never a loop: only use it for calls that
 * are safe to repeat.
 */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (options.signal?.aborted || !options.retryable(error)) throw error;
    await sleep(jitter(options.baseMs ?? 1000, options.random), options.signal);
    return fn();
  }
}
