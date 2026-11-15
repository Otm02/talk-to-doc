"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD_PX = 48;

/**
 * Keeps a scroll area pinned to its end while new content arrives, and stops
 * when the reader scrolls up. `behind` drives the "Jump to latest" chip.
 */
export function useStickToBottom(changeKey: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [behind, setBehind] = useState(false);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atEnd =
      el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD_PX;
    stuck.current = atEnd;
    setBehind(!atEnd);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [changeKey]);

  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = true;
    setBehind(false);
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, []);

  return { ref, onScroll, behind, jump };
}
