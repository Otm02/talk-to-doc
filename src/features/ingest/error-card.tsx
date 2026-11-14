import { AlertCircle } from "lucide-react";
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
  retryAfterSeconds,
  onAction,
}: {
  code: string;
  retryAfterSeconds?: number;
  onAction: (action: RecoveryAction) => void;
}) {
  const copy = errorCopy(code);
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
        <p className="text-sm">{copy.message}</p>
      </div>
      {retryAfterSeconds ? (
        <p className="text-sm text-muted-foreground">
          You can try again in {retryAfterSeconds}{" "}
          {retryAfterSeconds === 1 ? "second" : "seconds"}.
        </p>
      ) : null}
      <Button className="h-11" onClick={() => onAction(copy.action)}>
        {LABEL[copy.action]}
      </Button>
    </div>
  );
}
