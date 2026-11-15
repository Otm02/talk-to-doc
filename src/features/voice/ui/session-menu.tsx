"use client";

import { FileText, KeyboardOff, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import type { TranscriptExportApi } from "../export/use-transcript-export";
import { ExportButtons } from "./export-buttons";

const ROW = "h-14 w-full justify-start gap-3 px-3 text-base";

/**
 * The header's overflow menu, as a bottom sheet: thumb-sized rows instead of
 * a small popover under a finger at the top of the screen. It holds what the
 * slim header has no room for.
 */
export function SessionMenu({
  open,
  onOpenChange,
  title,
  exportApi,
  onShowText,
  onHideKeyboard,
  debug,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  exportApi: TranscriptExportApi;
  onShowText: () => void;
  /** Present only when a voice chat has its composer open. */
  onHideKeyboard?: () => void;
  /** Dev tools (cost, events), shown with ?debug=1 or in development. */
  debug?: ReactNode;
}) {
  const close = () => onOpenChange(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        data-testid="session-menu"
        className="max-h-[85dvh] gap-1 overflow-y-auto px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <div className="flex items-center gap-2 pl-3">
          <SheetTitle className="min-w-0 flex-1 truncate text-base">
            {title}
          </SheetTitle>
          <SheetClose
            render={<Button variant="ghost" className="size-11" />}
            aria-label="Close menu"
          >
            <X aria-hidden />
          </SheetClose>
        </div>
        <SheetDescription className="sr-only">
          Show the document text, or copy or download this conversation.
        </SheetDescription>

        <Button
          variant="ghost"
          className={ROW}
          onClick={() => {
            close();
            onShowText();
          }}
        >
          <FileText aria-hidden />
          Show full text
        </Button>
        <ExportButtons api={exportApi} layout="rows" />
        {onHideKeyboard && (
          <Button
            variant="ghost"
            className={ROW}
            onClick={() => {
              close();
              onHideKeyboard();
            }}
          >
            <KeyboardOff aria-hidden />
            Hide keyboard
          </Button>
        )}
        {debug && (
          <div
            data-testid="menu-debug"
            className="mt-1 flex flex-col gap-2 border-t px-3 pt-3"
          >
            {debug}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
