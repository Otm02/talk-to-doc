import { AudioLines } from "lucide-react";
import type { ReactNode } from "react";

// Single column at phone width. dvh keeps the bar usable when the mobile
// browser chrome grows or shrinks; safe-area padding clears notches.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <header className="flex min-h-14 items-center gap-2 border-b px-4 pt-[env(safe-area-inset-top)]">
        <AudioLines aria-hidden className="size-5" />
        <span className="text-base font-semibold">Talk to a Doc</span>
      </header>
      <main className="flex flex-1 flex-col gap-4 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {children}
      </main>
    </div>
  );
}
