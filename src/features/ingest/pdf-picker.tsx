"use client";

import { FileUp } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/utils";

/** A big tap target that opens the file picker; also accepts a dropped file. */
export function PdfPicker({
  onFile,
  disabled,
  inputRef,
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const [dragging, setDragging] = useState(false);

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && !disabled) onFile(file);
  }

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center focus-within:ring-3 focus-within:ring-ring/50",
        dragging ? "border-primary bg-muted" : "border-muted-foreground/40",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <FileUp aria-hidden className="size-8 text-muted-foreground" />
      <span className="text-base font-medium">Choose a PDF</span>
      <span className="text-sm text-muted-foreground">Up to 25 MB</span>
      <input
        ref={ref}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-label="Choose a PDF (up to 25 MB)"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again still fires onChange.
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
    </label>
  );
}
