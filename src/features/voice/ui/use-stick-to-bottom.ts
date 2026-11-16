"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD_PX = 48;

/**
 * Keeps a scroll area pinned to its end while new content arrives, and stops
 * when the reader scrolls up. `behind` drives the "Jump to latest" chip.
 *
 * It also re-pins when the area itself changes size. Opening the soft keyboard
 * shrinks the screen without any scroll event, so the newest answer would end
 * up under the keyboard. A reader who was near the end stays at the end; one
 * who had scrolled up is left where they were.
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

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      // Judge "was near the end" by the height before this resize: after it,
      // the distance has grown by exactly what the resize took away.
      const before = el.scrollHeight - el.scrollTop - lastHeight;
      lastHeight = el.clientHeight;
      if (stuck.current || before <= THRESHOLD_PX) {
        stuck.current = true;
        el.scrollTop = el.scrollHeight;
        setBehind(false);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
