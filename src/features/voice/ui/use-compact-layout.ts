"use client";

import { useViewportVars } from "./use-visual-viewport";

/** The keyboard is taken to be open when under this share of the page is visible. */
export const KEYBOARD_RATIO = 0.75;

export interface CompactLayout {
  /** Give the transcript the room: slim header, no orb, controls in the composer row. */
  compact: boolean;
  /** The soft keyboard (or something as tall) is covering the page. */
  keyboardOpen: boolean;
}

/**
 * Decides when the chat screen drops its roomy voice layout. Any one of these
 * is enough:
 *  - the composer is open (the user is about to type, the keyboard follows),
 *  - the visible height fell below ~75% of the full height (keyboard is up),
 *  - text mode (there is no orb to show anyway).
 * It also keeps the `--vvh` / `--vvt` CSS variables current, so the screen
 * that uses it is sized to the visible area.
 */
export function useCompactLayout({
  composerOpen,
  textMode,
}: {
  composerOpen: boolean;
  textMode: boolean;
}): CompactLayout {
  const box = useViewportVars();
  const keyboardOpen =
    box !== null && box.height < KEYBOARD_RATIO * box.fullHeight;
  return { compact: composerOpen || textMode || keyboardOpen, keyboardOpen };
}
