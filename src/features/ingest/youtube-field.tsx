"use client";

import { ClipboardPaste } from "lucide-react";
import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { checkYoutubeInput } from "./validate-youtube";

const subscribe = () => () => undefined;
const canPaste = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.clipboard?.readText === "function";

export function YoutubeField({
  onSubmit,
  disabled,
  initialValue = "",
}: {
  onSubmit: (url: string) => void;
  disabled?: boolean;
  initialValue?: string;
}) {
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);
  // false on the server, so the Paste button never causes a hydration mismatch.
  const pasteSupported = useSyncExternalStore(subscribe, canPaste, () => false);
  const check = checkYoutubeInput(value);
  const showError = check.status === "invalid" && (touched || value.length > 8);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (check.status === "valid") onSubmit(value.trim());
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      setValue(text.trim());
      setTouched(true);
    } catch {
      // Permission denied: the user can still type or long-press paste.
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
      <label htmlFor={id} className="text-sm font-medium">
        YouTube link
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste a YouTube link"
          value={value}
          disabled={disabled}
          aria-invalid={showError}
          aria-describedby={showError ? `${id}-error` : undefined}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
        />
        {pasteSupported && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={disabled}
            onClick={paste}
          >
            <ClipboardPaste aria-hidden />
            Paste
          </Button>
        )}
      </div>
      {showError && check.status === "invalid" && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {check.message}
        </p>
      )}
      <Button
        type="submit"
        className="h-12 text-base"
        disabled={disabled || check.status !== "valid"}
      >
        Load video
      </Button>
    </form>
  );
}
