"use client";

import { WifiOff } from "lucide-react";
import { useOnline } from "@/lib/net/use-online";
import { cn } from "@/lib/utils";
import { useChatOpen } from "./chat-open";

/**
 * Shown while the device has no link or our last request got no answer. The
 * copy promises what the app really does: loads and chats pick up again by
 * themselves when the connection is back.
 */
export function OfflineBanner({
  className,
  hideWhenChatOpen = false,
}: {
  className?: string;
  /**
   * The page's own banner sets this: while a chat is open it has its own, and
   * two would be announced. The chat's banner leaves it off.
   */
  hideWhenChatOpen?: boolean;
}) {
  const online = useOnline();
  const chatOpen = useChatOpen();
  if (online || (hideWhenChatOpen && chatOpen)) return null;
  return (
    <p
      role="status"
      data-testid="offline-banner"
      className={cn(
        "flex items-center gap-2 border-b border-warning/50 bg-warning/15 px-4 py-2 text-sm text-warning-foreground",
        className,
      )}
    >
      <WifiOff aria-hidden className="size-4 shrink-0" />
      {/* SPEC §3.5 copy, straight apostrophes and all. */}
      {"You're offline. We'll reconnect when you're back."}
    </p>
  );
}
