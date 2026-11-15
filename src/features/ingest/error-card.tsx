import { AlertCircle } from "lucide-react";
import { InitialWait, RetryButton } from "@/components/retry-button";
import { Button } from "@/components/ui/button";
import { errorCopy, type RecoveryAction } from "./error-copy";

const LABEL: Record<RecoveryAction, string> = {
  retry: "Try again",
  "pick-another-file": "Choose another file",
  "edit-link": "Edit link",
  "try-pdf": "Try a PDF instead",
  reload: "Reload",
};

export function ErrorCard({
  code,
  retryAt,
  onAction,
}: {
  code: string;
  /** Deadline (ms since epoch) from a 429; only "Try again" waits for it. */
  retryAt?: number;
  onAction: (action: RecoveryAction) => void;
}) {
  const copy = errorCopy(code);
  // Choosing another file or editing the link is never rate limited.
  const waitUntil = copy.action === "retry" ? retryAt : undefined;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
      {/* Only this line is the alert: the ticking button must stay outside it. */}
      <div role="alert" className="flex items-start gap-2">
        <AlertCircle
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <p className="text-sm">
          {copy.message}
          <InitialWait key={waitUntil} retryAt={waitUntil} />
        </p>
      </div>
      {copy.action === "retry" ? (
        <RetryButton
          key={waitUntil}
          retryAt={waitUntil}
          label={LABEL.retry}
          onRetry={() => onAction("retry")}
          className="h-11"
        />
      ) : (
        <Button className="h-11" onClick={() => onAction(copy.action)}>
          {LABEL[copy.action]}
        </Button>
      )}
    </div>
  );
}
