"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DocumentData } from "@/features/ingest/ingest-state";
import { FullTextSheet } from "./full-text-sheet";
import { buildGroups, previewExcerpt } from "./text-groups";

export function TextPreview({ doc }: { doc: DocumentData }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => buildGroups(doc), [doc]);
  const excerpt = useMemo(() => previewExcerpt(groups.slice(0, 5)), [groups]);

  return (
    <section aria-label="Extracted text" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Extracted text</h3>
      <p className="rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
        {excerpt || "Reading…"}
      </p>
      <Button
        variant="outline"
        className="h-11"
        onClick={() => setOpen(true)}
        disabled={groups.length === 0}
      >
        Show full text
      </Button>
      <FullTextSheet
        open={open}
        onOpenChange={setOpen}
        groups={groups}
        complete={doc.done !== null}
      />
    </section>
  );
}
