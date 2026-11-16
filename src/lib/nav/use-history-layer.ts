"use client";

import { useEffect, useRef } from "react";
import { pushLayer } from "./history-layers";

/**
 * While `active`, the browser's Back closes this layer first. `onBack` runs
 * when Back was pressed: return false to stay (it also gets its history entry
 * back), anything else means it closed. Closing from the screen is the
 * caller's own state change, and takes the history entry away by itself.
 */
export function useHistoryLayer(
  active: boolean,
  onBack: () => boolean | void,
): void {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    return pushLayer(() => latest.current() !== false);
  }, [active]);
}
