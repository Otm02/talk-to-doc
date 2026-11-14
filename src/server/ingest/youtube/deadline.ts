import "server-only";
import { TranscriptError } from "./provider";

export interface Deadline {
  /** Aborts when the parent aborts or the time runs out. */
  readonly signal: AbortSignal;
  /** True only if it was our timer, not the caller, that aborted. */
  readonly timedOut: boolean;
  dispose(): void;
}

/**
 * A timeout that covers a whole provider attempt (several requests), built on
 * setTimeout so tests can drive it with fake timers. AbortSignal.timeout runs
 * on an internal clock they cannot advance.
 */
export function createDeadline(parent: AbortSignal, ms: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) onParentAbort();
  else parent.addEventListener("abort", onParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, ms);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Runs `fn` under a deadline and translates what comes out: our timer firing
 * is UPSTREAM_TIMEOUT, a TranscriptError passes through, the caller aborting
 * passes through untouched (it is not an upstream failure), and anything else
 * (a network error, a bad body) is UPSTREAM_FAILED.
 */
export async function withDeadline<T>(
  parent: AbortSignal,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = createDeadline(parent, ms);
  try {
    return await fn(deadline.signal);
  } catch (err) {
    if (deadline.timedOut) {
      throw new TranscriptError("UPSTREAM_TIMEOUT", { cause: err });
    }
    if (parent.aborted) throw err;
    if (err instanceof TranscriptError) throw err;
    throw new TranscriptError("UPSTREAM_FAILED", { cause: err });
  } finally {
    deadline.dispose();
  }
}
