// A deadline for one request, combined with the caller's own abort signal.
// AbortSignal.any / .timeout are missing on older iOS Safari, so the two are
// joined by hand.

export interface Deadline {
  /** Pass this to fetch. Aborts on the caller's abort or when the time is up. */
  signal: AbortSignal;
  /** True only when the time ran out, not when the caller aborted. */
  timedOut(): boolean;
  /**
   * Stops the clock but keeps following the caller's abort. Use it once the
   * response has arrived: the deadline was for the first byte, but a body that
   * is still streaming must stop when the caller cancels.
   */
  disarm(): void;
  /** Stops the clock and lets go of the caller's signal. Call it when the request is over. */
  dispose(): void;
}

export function withTimeout(
  parent: AbortSignal | undefined,
  ms: number,
): Deadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  const onParent = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParent, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => expired,
    disarm: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
