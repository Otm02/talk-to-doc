"use client";

import { FileText, Link2 } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export type Source = "pdf" | "youtube";

const OPTIONS: { value: Source; label: string; Icon: typeof FileText }[] = [
  { value: "pdf", label: "PDF", Icon: FileText },
  { value: "youtube", label: "YouTube", Icon: Link2 },
];

/** A two-option segmented control, built as a radio group so arrows work. */
export function SourceSwitch({
  value,
  onChange,
  disabled,
}: {
  value: Source;
  onChange: (value: Source) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Record<Source, HTMLButtonElement | null>>({
    pdf: null,
    youtube: null,
  });

  function onKeyDown(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
      return;
    event.preventDefault();
    const next: Source = value === "pdf" ? "youtube" : "pdf";
    onChange(next);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Source"
      onKeyDown={onKeyDown}
      className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
    >
      {OPTIONS.map(({ value: option, label, Icon }) => {
        const selected = option === value;
        return (
          <button
            key={option}
            ref={(node) => {
              refs.current[option] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option)}
            className={cn(
              "flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
