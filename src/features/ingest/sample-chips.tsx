"use client";

import { Button } from "@/components/ui/button";

// Both are public and known to work: a US federal document bundled in
// /public/samples, and a 19-second video with manual English captions.
export const SAMPLE_PDF = {
  url: "/samples/sample.pdf",
  name: "sample.pdf",
} as const;
export const SAMPLE_VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

export function SampleChips({
  onPdf,
  onVideo,
  disabled,
}: {
  onPdf: () => void;
  onVideo: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">Try a sample</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="h-11 rounded-full px-4"
          disabled={disabled}
          onClick={onPdf}
        >
          Sample PDF
        </Button>
        <Button
          variant="outline"
          className="h-11 rounded-full px-4"
          disabled={disabled}
          onClick={onVideo}
        >
          Sample video
        </Button>
      </div>
    </div>
  );
}
