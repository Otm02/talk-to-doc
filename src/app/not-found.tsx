import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { StatusScreen } from "@/components/status-screen";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <StatusScreen
      icon={<FileQuestion className="size-7" />}
      title="Page not found."
      message="That address does not lead anywhere here."
    >
      <Link href="/" className={cn(buttonVariants(), "h-12 text-base")}>
        Go home
      </Link>
    </StatusScreen>
  );
}
