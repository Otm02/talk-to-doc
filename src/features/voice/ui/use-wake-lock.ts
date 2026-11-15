"use client";

import { useEffect } from "react";

/**
 * Keeps the screen on while `active`. The browser drops the lock whenever the
 * page is hidden, so it is taken again when the page comes back.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
      } catch {
        // Denied (battery saver, no permission): the chat still works.
      }
    };
    const release = () => {
      const lock = sentinel;
      sentinel = null;
      void lock?.release().catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
      else if (!sentinel) void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [active]);
}
