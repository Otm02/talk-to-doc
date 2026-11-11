import { FileText } from "lucide-react";

export default function Home() {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground">
      <FileText aria-hidden className="size-6 text-muted-foreground" />
      <h1 className="text-xl font-semibold">Talk to a document</h1>
      <p className="text-sm text-muted-foreground">
        Upload a PDF or paste a YouTube link, then ask about it out loud. Coming
        soon.
      </p>
    </section>
  );
}
