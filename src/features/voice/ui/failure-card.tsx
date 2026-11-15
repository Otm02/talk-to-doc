import { AlertCircle } from "lucide-react";
import { InitialWait, RetryButton } from "@/components/retry-button";
import { failureMessage, type FailureCode } from "../realtime/failure";

/**
 * Why the chat could not start or had to stop. Retry is a tap, never automatic:
 * budget errors in particular would only repeat. After a 429 the button counts
 * down to the moment a retry can work and stays disabled until then, so a tap
 * cannot spend another attempt against the limit.
 */
export function FailureCard({
  code,
  retryAt,
  onRetry,
}: {
  code: FailureCode;
  /** Deadline (ms since epoch) from a 429; undefined = retry right away. */
  retryAt?: number;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="failure-card"
      data-code={code}
      className="mx-4 flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
    >
      {/* Only this line is the alert: the ticking button must stay outside it. */}
      <p role="alert" className="flex items-start gap-2 text-sm">
        <AlertCircle
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <span>
          {failureMessage(code)}
          <InitialWait key={retryAt} retryAt={retryAt} />
        </span>
      </p>
      <RetryButton
        key={retryAt}
        retryAt={retryAt}
        onRetry={onRetry}
        variant="outline"
        className="h-11"
      />
    </div>
  );
}
