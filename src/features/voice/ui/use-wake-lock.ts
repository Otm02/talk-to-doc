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
    // A request is in flight. Coming back to the page while the first one is
    // still pending would otherwise ask again, and the lock that lost the race
    // would be forgotten while still held.
    let acquiring = false;

    const acquire = async () => {
      if (sentinel || acquiring) return;
      acquiring = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled || sentinel) {
          void lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
      } catch {
        // Denied (battery saver, no permission): the chat still works.
      } finally {
        acquiring = false;
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
