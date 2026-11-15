"use client";

import { useEffect, useRef } from "react";
import type { LevelKind } from "../realtime/levels";

type Subscribe = (kind: LevelKind, listener: (level: number) => void) => () => void;

/**
 * The orb reacts to how loud you are (blue ring) and how loud the assistant
 * is (neutral ring). Levels go straight to CSS variables: no React renders at
 * animation-frame rate. With reduced motion it stays still.
 */
export function Orb({ subscribeLevel, dimmed }: { subscribeLevel: Subscribe; dimmed: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const offs = [
      subscribeLevel("mic", (l) => el.style.setProperty("--mic", String(l))),
      subscribeLevel("remote", (l) => el.style.setProperty("--remote", String(l))),
    ];
    return () => offs.forEach((off) => off());
  }, [subscribeLevel]);

  return (
    <div
      ref={root}
      data-testid="orb"
      aria-hidden
      style={{ "--mic": 0, "--remote": 0 } as React.CSSProperties}
      className={`relative grid size-40 shrink-0 place-items-center transition-opacity ${dimmed ? "opacity-40" : ""}`}
    >
      <div
        data-testid="orb-assistant"
        className="absolute inset-0 rounded-full bg-primary/25 will-change-transform motion-reduce:transform-none"
        style={{ transform: "scale(calc(0.7 + var(--remote) * 0.3))" }}
      />
      <div
        data-testid="orb-you"
        className="absolute inset-4 rounded-full bg-user/35 will-change-transform motion-reduce:transform-none"
        style={{ transform: "scale(calc(0.75 + var(--mic) * 0.25))" }}
      />
      <div className="size-14 rounded-full bg-foreground/90 shadow-lg" />
    </div>
  );
}
