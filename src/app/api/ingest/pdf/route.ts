import { handle } from "@/server/http";
import { ingestPdf } from "@/server/ingest/pdf/request";

// Reading a big PDF can take a while; the pipeline stops itself at 55 s.
// No `runtime` or `dynamic` export: both are rejected under cacheComponents.
export const maxDuration = 60;

export const POST = handle(ingestPdf);
