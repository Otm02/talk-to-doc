"use client";

import { useSyncExternalStore } from "react";
import { isDebug } from "../realtime/debug";

const subscribe = () => () => {};

/**
 * True in development or with ?debug=1. False on the server and during
 * hydration, so the overlay never causes a markup mismatch.
 */
export function useDebug(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isDebug(),
    () => false,
  );
}
