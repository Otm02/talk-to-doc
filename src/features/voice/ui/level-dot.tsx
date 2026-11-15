"use client";

import { useEffect, useRef } from "react";
import type { LevelKind } from "../realtime/levels";

type Subscribe = (
  kind: LevelKind,
  listener: (level: number) => void,
) => () => void;

/**
 * The orb, folded into the status pill for the compact layout: one dot that
 * swells with whoever is louder, you or the assistant. Levels go straight to
 * a CSS variable, with no React renders. With reduced motion it stays still.
 */
export function LevelDot({ subscribeLevel }: { subscribeLevel: Subscribe }) {
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const levels = { mic: 0, remote: 0 };
    const paint = () =>
      el.style.setProperty(
        "--level",
        String(Math.max(levels.mic, levels.remote)),
      );
    const offs = (["mic", "remote"] as const).map((kind) =>
      subscribeLevel(kind, (l) => {
        levels[kind] = l;
        paint();
      }),
    );
    return () => offs.forEach((off) => off());
  }, [subscribeLevel]);

  return (
    <span
      ref={root}
      data-testid="level-dot"
      aria-hidden
      style={{ "--level": 0 } as React.CSSProperties}
      className="relative grid size-4 shrink-0 place-items-center"
    >
      <span
        className="absolute size-2.5 rounded-full bg-current opacity-30 will-change-transform motion-reduce:transform-none"
        style={{ transform: "scale(calc(1 + var(--level) * 0.9))" }}
      />
      <span className="size-2 rounded-full bg-current" />
    </span>
  );
}
