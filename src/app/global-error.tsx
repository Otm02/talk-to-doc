"use client";

import { TriangleAlert } from "lucide-react";
import { StatusScreen } from "@/components/status-screen";
import { Button } from "@/components/ui/button";
import "./globals.css";

// Replaces the root layout when that itself crashes, so it brings its own
// document and styles, and cannot use anything the layout provides (the app
// shell, the fonts). Reload is the only honest recovery: the layout is gone.
export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-[env(safe-area-inset-top)] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <StatusScreen
            icon={<TriangleAlert className="size-7" />}
            title="Something went wrong."
            message="Reload to try again."
          >
            <Button
              className="h-12 text-base"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </StatusScreen>
        </main>
      </body>
    </html>
  );
}
