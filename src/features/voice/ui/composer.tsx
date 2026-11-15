"use client";

import { Send, Square } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The typing row. In the compact layout it is also the control bar: the mic
 * toggle sits before the field (`leading`) and End after Send (`trailing`),
 * so one 60 px row replaces the composer plus a 56 px bar. Enter sends; the
 * field stays at 16px so iOS does not zoom on focus.
 */
export function Composer({
  onSend,
  disabled,
  autoFocus,
  leading,
  trailing,
  canStop = false,
  onStop,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** An answer is coming: with nothing typed, Send becomes Stop. */
  canStop?: boolean;
  onStop?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const empty = draft.trim() === "";

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
    input.current?.focus();
  }

  return (
    <form
      data-testid="composer-row"
      className="flex items-center gap-2 border-t px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {leading}
      <input
        ref={input}
        data-testid="composer"
        aria-label="Message"
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        enterKeyHint="send"
        // Short enough to fit beside three buttons on a 360 px screen.
        placeholder="Ask a question"
        autoComplete="off"
        className="h-11 min-w-0 flex-1 rounded-xl border bg-background px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      {canStop && empty && onStop ? (
        <Button
          type="button"
          variant="outline"
          aria-label="Stop answer"
          className="size-11"
          onClick={onStop}
        >
          <Square aria-hidden />
        </Button>
      ) : (
        <Button
          type="submit"
          aria-label="Send"
          className="size-11"
          disabled={disabled || empty}
        >
          <Send aria-hidden />
        </Button>
      )}
      {trailing}
    </form>
  );
}
