import { abortError, sleep, withTimeout } from "./timeout";

// One answer to "can this page reach our server?", shared by the offline
// banner, the status pill and every retry. navigator.onLine alone can prove
// "offline" but never "online" (it stays true behind a dead router), so it is
// combined with what requests actually did:
//  - a request that got no response at all marks us unreachable;
//  - ANY HTTP response, 429 and 500 included, marks us reachable, because a
//    server answered. That keeps M8's rule: a refusal is never "Offline".

let unreachable = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function isOffline(): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  return unreachable;
}

export function markUnreachable(): void {
  if (unreachable) return;
  unreachable = true;
  emit();
}

export function markReachable(): void {
  if (!unreachable) return;
  unreachable = false;
  emit();
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  const onLink = () => {
    // The browser says the link is back: forget the old failure and let the
    // next request prove it.
    if (typeof navigator !== "undefined" && navigator.onLine)
      unreachable = false;
    listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", onLink);
    window.addEventListener("offline", onLink);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onLink);
      window.removeEventListener("offline", onLink);
    }
  };
}

/** Test hook. */
export function resetConnectivityForTests(): void {
  unreachable = false;
  listeners.clear();
}

/**
 * One probe may take this long. Behind a dead router the browser would wait
 * far longer for the connection to fail by itself, and the wait would sit
 * "offline" long after the link is back.
 */
export const PROBE_TIMEOUT_MS = 5_000;

export interface WaitOptions {
  /** Probe delays, doubling up to this. Default 2 s to 30 s. */
  firstProbeMs?: number;
  maxProbeMs?: number;
  /** Resolves true when the server answered. It must give up when `signal` aborts. */
  probe?: (signal: AbortSignal) => Promise<boolean>;
}

async function probeHealth(signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal });
    // Any answer proves the path works, even an error page.
    void res;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves when the connection is back: the browser fires `online`, or a probe
 * of /api/health gets any answer. The probe only runs while the browser
 * claims to be online (otherwise `online` is the only honest signal).
 * Rejects with an AbortError when `signal` aborts.
 */
export function waitForConnection(
  signal?: AbortSignal,
  options: WaitOptions = {},
): Promise<void> {
  const probe = options.probe ?? probeHealth;
  const max = options.maxProbeMs ?? 30_000;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let done = false;
    const inner = new AbortController();
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      inner.abort();
      window.removeEventListener("online", onOnline);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else {
        markReachable();
        resolve();
      }
    };
    const onOnline = () => finish();
    const onAbort = () => finish(abortError());
    window.addEventListener("online", onOnline);
    signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      let delay = options.firstProbeMs ?? 2_000;
      while (!done) {
        try {
          await sleep(delay, inner.signal);
        } catch {
          return;
        }
        if (done) return;
        if (navigator.onLine) {
          // A deadline per probe, and the wait ending cancels one in flight.
          const deadline = withTimeout(inner.signal, PROBE_TIMEOUT_MS);
          let answered = false;
          try {
            answered = await probe(deadline.signal);
          } catch {
            answered = false;
          } finally {
            deadline.dispose();
          }
          if (answered) {
            finish();
            return;
          }
        }
        delay = Math.min(delay * 2, max);
      }
    })();

    // Already fine: nothing to wait for.
    if (navigator.onLine && !unreachable) finish();
  });
}
