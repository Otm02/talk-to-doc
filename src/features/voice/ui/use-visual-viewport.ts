"use client";

import { useEffect, useSyncExternalStore } from "react";

// The part of the page the user can actually see. On a phone the soft
// keyboard covers the bottom of the layout viewport; `dvh` and `inset-0` do
// not know that everywhere (iOS Safari keeps the layout viewport full height
// and scrolls it instead). visualViewport does, so the chat is sized from it.

export interface ViewportBox {
  /** Visible height in CSS px. */
  height: number;
  /** How far the visible area has been scrolled down inside the page. */
  offsetTop: number;
  /**
   * The tallest the page has been at this width: the height with no keyboard.
   * window.innerHeight alone is not enough, because browsers that resize the
   * layout for the keyboard (interactive-widget=resizes-content) shrink it too.
   */
  fullHeight: number;
}

let cached: ViewportBox | null = null;
let tallest = { width: 0, height: 0 };
let subscribers = 0;

/**
 * Above this the user has pinch-zoomed. A zoomed visual viewport covers less
 * of the page, which looks exactly like a keyboard; scale 1.05 leaves room
 * for the rounding some browsers report at "no zoom".
 */
export const ZOOM_SCALE = 1.05;

function read(): ViewportBox | null {
  const vv = window.visualViewport;
  if (!vv) return null;
  const width = window.innerWidth;
  // A rotation is a different screen: start measuring again.
  if (width !== tallest.width) tallest = { width, height: 0 };
  // Zoomed in, the visible area is smaller by the zoom factor. Scaling it
  // back gives the layout height still on show, so a zoom alone changes
  // nothing and a keyboard opened while zoomed still does. The pan offset is
  // ignored: the chat stays where the layout puts it and the user pans the zoom.
  const zoomed = (vv.scale ?? 1) > ZOOM_SCALE;
  const visible = zoomed ? vv.height * vv.scale : vv.height;
  tallest.height = Math.max(tallest.height, window.innerHeight, visible);
  const next: ViewportBox = {
    height: Math.round(visible),
    offsetTop: zoomed ? 0 : Math.max(0, Math.round(vv.offsetTop)),
    fullHeight: Math.round(tallest.height),
  };
  // Same object while nothing changed, as useSyncExternalStore requires.
  if (
    cached &&
    cached.height === next.height &&
    cached.offsetTop === next.offsetTop &&
    cached.fullHeight === next.fullHeight
  ) {
    return cached;
  }
  cached = next;
  return next;
}

function subscribe(onChange: () => void): () => void {
  const vv = window.visualViewport;
  subscribers += 1;
  vv?.addEventListener("resize", onChange);
  vv?.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    vv?.removeEventListener("resize", onChange);
    vv?.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
    subscribers -= 1;
    // Nobody is looking: forget, so the next screen measures from scratch.
    if (subscribers === 0) {
      cached = null;
      tallest = { width: 0, height: 0 };
    }
  };
}

const none = () => null;

/** null on the server and in browsers without visualViewport. */
export function useVisualViewport(): ViewportBox | null {
  return useSyncExternalStore(subscribe, read, none);
}

/**
 * Publishes the visible area as CSS variables on <html> while mounted:
 * `--vvh` (height) and `--vvt` (offset from the top). A fixed element sized
 * with them always ends exactly where the keyboard begins. Without
 * visualViewport nothing is set, and the CSS fallbacks (100dvh, 0px) apply.
 */
export function useViewportVars(): ViewportBox | null {
  const box = useVisualViewport();
  const height = box?.height;
  const offsetTop = box?.offsetTop;
  useEffect(() => {
    const root = document.documentElement;
    if (height === undefined || offsetTop === undefined) return;
    root.style.setProperty("--vvh", `${height}px`);
    root.style.setProperty("--vvt", `${offsetTop}px`);
    // Also when the numbers go away, not only on unmount: a stale height
    // would leave the screen cut short, and the CSS fallbacks are always safe.
    return () => {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
    };
  }, [height, offsetTop]);
  return box;
}
