import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { failureMessage, type FailureCode } from "../realtime/failure";

/**
 * Why the chat could not start or had to stop. Retry is a tap, never automatic:
 * budget errors in particular would only repeat.
 */
export function FailureCard({
  code,
  retryAfterSeconds,
  onRetry,
}: {
  code: FailureCode;
  retryAfterSeconds?: number;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="failure-card"
      data-code={code}
      className="mx-4 flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
    >
      <p className="flex items-start gap-2 text-sm">
        <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
        {failureMessage(code)}
      </p>
      {retryAfterSeconds ? (
        <p className="text-sm text-muted-foreground">
          You can try again in {retryAfterSeconds}{" "}
          {retryAfterSeconds === 1 ? "second" : "seconds"}.
        </p>
      ) : null}
      <Button variant="outline" className="h-11" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
