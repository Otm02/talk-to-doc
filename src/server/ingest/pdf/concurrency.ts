import "server-only";
import { catalogError } from "../../errors";

export interface Semaphore {
  /**
   * Resolves with a release function once a slot is free. Rejects with
   * pdf_timeout if the deadline passes while waiting, so a busy instance
   * answers in time instead of hanging past the function limit.
   */
  acquire(deadline: number): Promise<() => void>;
  readonly active: number;
  readonly waiting: number;
}

/**
 * Per-instance on purpose: it caps CPU and memory on this process, which is
 * not shared state. Parsing runs on the event loop, so more than a couple of
 * big documents at once would starve everything else.
 */
export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiters: Array<() => void> = [];

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      waiters.shift()?.();
    };
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
    acquire(deadline) {
      if (active < max) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve, reject) => {
        const grant = () => {
          clearTimeout(timer);
          active += 1;
          resolve(makeRelease());
        };
        const timer = setTimeout(
          () => {
            const index = waiters.indexOf(grant);
            if (index !== -1) waiters.splice(index, 1);
            reject(catalogError("pdf_timeout"));
          },
          Math.max(0, deadline - Date.now()),
        );
        waiters.push(grant);
      });
    },
  };
}
