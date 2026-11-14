"use client";

import { Send } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Enter sends; the field stays at 16px so iOS does not zoom on focus. */
export function Composer({
  onSend,
  disabled,
  autoFocus,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
    input.current?.focus();
  }

  return (
    <form
      className="flex gap-2 px-4 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={input}
        data-testid="composer"
        aria-label="Message"
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        enterKeyHint="send"
        placeholder="Ask about this document"
        autoComplete="off"
        className="h-12 min-w-0 flex-1 rounded-xl border bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      <Button
        type="submit"
        aria-label="Send"
        className="size-12"
        disabled={disabled || draft.trim() === ""}
      >
        <Send aria-hidden />
      </Button>
    </form>
  );
}
