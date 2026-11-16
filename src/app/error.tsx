"use client";

import { TriangleAlert } from "lucide-react";
import { StatusScreen } from "@/components/status-screen";
import { Button } from "@/components/ui/button";

// Catches a crash below the layout. The text is fixed on purpose: the error
// itself can carry anything, and none of it is for the user.
export default function RouteError({
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <StatusScreen
      icon={<TriangleAlert className="size-7" />}
      title="Something went wrong."
      message="Try again. If it keeps happening, reload the page."
    >
      <Button className="h-12 text-base" onClick={() => retry()}>
        Try again
      </Button>
      <Button
        variant="outline"
        className="h-12 text-base"
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
    </StatusScreen>
  );
}
