"use client";

import { useSyncExternalStore } from "react";
import { isOffline, subscribeConnectivity } from "@/lib/net/connectivity";

/**
 * Whether the page can reach us, live. Combines navigator.onLine (which can
 * prove "offline" but never "online") with what requests actually did: a
 * request that got no answer counts, an answer of any kind clears it. The
 * server render assumes online.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeConnectivity,
    () => !isOffline(),
    () => true,
  );
}
