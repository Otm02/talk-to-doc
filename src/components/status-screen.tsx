import type { ReactNode } from "react";

/**
 * A whole-page message with one or two big buttons: not found, a crash. Plain
 * server-renderable markup so the root error screen, which has no layout
 * around it, can use it as well. The one h1 of its page.
 */
export function StatusScreen({
  icon,
  title,
  message,
  children,
}: {
  icon: ReactNode;
  title: string;
  message: string;
  /** The buttons. */
  children: ReactNode;
}) {
  return (
    <div
      data-testid="status-screen"
      className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center"
    >
      <div
        aria-hidden
        className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">{children}</div>
    </div>
  );
}
