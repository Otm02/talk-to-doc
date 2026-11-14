"use client";

import { Check, ChevronDown, ChevronUp, Copy, Search, X } from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  groupsToPlainText,
  indexMatches,
  splitByQuery,
  type TextGroup,
  type TextUnit,
} from "./text-groups";

// A page or block is cheap to render once; a thousand at once is not. Render
// a batch, then more as the reader scrolls.
const BATCH = 20;

type CopyState = "idle" | "copied" | "failed";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: TextGroup[];
  complete: boolean;
}

export function FullTextSheet({ open, onOpenChange, groups, complete }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="data-[side=bottom]:h-dvh gap-0 overflow-hidden rounded-none pt-[env(safe-area-inset-top)]"
      >
        <SheetBody groups={groups} complete={complete} />
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  groups,
  complete,
}: {
  groups: TextGroup[];
  complete: boolean;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState(BATCH);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => indexMatches(groups, deferredQuery),
    [groups, deferredQuery],
  );
  const activeIndex = matches.total ? Math.min(active, matches.total - 1) : 0;

  // A match in a group that isn't rendered yet must be reachable.
  const activeGroup = matches.total ? (matches.groupOfMatch[activeIndex] ?? -1) : -1;
  const rendered = Math.min(groups.length, Math.max(visible, activeGroup + 1));

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible((v) => v + BATCH);
        }
      },
      { root: scrollRef.current, rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rendered, groups.length]);

  useEffect(() => {
    if (!matches.total) return;
    scrollRef.current
      ?.querySelector('mark[data-active="true"]')
      ?.scrollIntoView({ block: "center" });
  }, [activeIndex, matches.total, deferredQuery, rendered]);

  useEffect(() => {
    if (copyState === "idle") return;
    const t = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(t);
  }, [copyState]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(groupsToPlainText(groups));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const step = (delta: number) => {
    if (!matches.total) return;
    setActive((activeIndex + delta + matches.total) % matches.total);
  };

  return (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <SheetTitle className="flex-1">Full text</SheetTitle>
        <Button variant="outline" className="h-11" onClick={copy}>
          {copyState === "copied" ? (
            <Check aria-hidden />
          ) : (
            <Copy aria-hidden />
          )}
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy"}
        </Button>
        <SheetClose
          render={<Button variant="ghost" className="size-11" />}
          aria-label="Close full text"
        >
          <X aria-hidden />
        </SheetClose>
      </div>
      <SheetDescription className="sr-only">
        The complete extracted text. Search it or copy it.
      </SheetDescription>

      <div className="flex items-center gap-2 border-b px-4 py-2">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            aria-label="Search in text"
            placeholder="Search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
            }}
            className="h-11 w-full rounded-lg border bg-background pr-3 pl-9 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <span
          aria-live="polite"
          className="min-w-14 text-center text-sm text-muted-foreground"
        >
          {deferredQuery.trim()
            ? matches.total
              ? `${activeIndex + 1} of ${matches.total}`
              : "No match"
            : ""}
        </span>
        <Button
          variant="outline"
          className="size-11"
          aria-label="Previous match"
          disabled={!matches.total}
          onClick={() => step(-1)}
        >
          <ChevronUp aria-hidden />
        </Button>
        <Button
          variant="outline"
          className="size-11"
          aria-label="Next match"
          disabled={!matches.total}
          onClick={() => step(1)}
        >
          <ChevronDown aria-hidden />
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {groups.slice(0, rendered).map((group) => (
          <section
            key={group.id}
            aria-label={group.label}
            // Skips layout and paint for groups far off screen.
            className="border-b py-3 [contain-intrinsic-size:auto_240px] [content-visibility:auto]"
          >
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">
              {group.label}
            </h4>
            {group.units.map((unit) => (
              <UnitText
                key={unit.id}
                unit={unit}
                query={deferredQuery}
                base={matches.base.get(unit.id)}
                count={matches.count.get(unit.id) ?? 0}
                active={activeIndex}
              />
            ))}
          </section>
        ))}
        {rendered < groups.length && (
          <Button
            ref={sentinelRef}
            variant="ghost"
            className="my-3 h-11 w-full"
            onClick={() => setVisible((v) => v + BATCH)}
          >
            Show more ({groups.length - rendered} left)
          </Button>
        )}
        {!complete && (
          <p className="py-3 text-sm text-muted-foreground">Still reading…</p>
        )}
      </div>
    </>
  );
}

function UnitText({
  unit,
  query,
  base,
  count,
  active,
}: {
  unit: TextUnit;
  query: string;
  base: number | undefined;
  count: number;
  active: number;
}) {
  const parts = count > 0 ? splitByQuery(unit.text, query) : null;
  let seen = 0;
  return (
    <p className="py-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
      {unit.stamp && (
        <a
          href={unit.stamp.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open at ${unit.stamp.label} on YouTube`}
          className="mr-2 inline-flex min-h-11 items-center font-mono text-xs text-primary underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {unit.stamp.label}
        </a>
      )}
      {parts
        ? parts.map((part, i) => {
            if (!part.match) return <span key={i}>{part.text}</span>;
            const isActive = base !== undefined && base + seen === active;
            seen += 1;
            return (
              <mark
                key={i}
                data-active={isActive}
                className={
                  isActive
                    ? "rounded bg-primary text-primary-foreground"
                    : "rounded bg-accent text-accent-foreground"
                }
              >
                {part.text}
              </mark>
            );
          })
        : unit.text}
    </p>
  );
}
