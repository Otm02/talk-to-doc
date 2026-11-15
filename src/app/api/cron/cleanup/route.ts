import { handle } from "@/server/http";
import { cleanupUploads } from "@/server/ingest/pdf/cleanup";

// A few list and delete calls. No `runtime` or `dynamic` export: both are
// rejected under cacheComponents.
export const maxDuration = 30;

export const GET = handle("cron-cleanup", (req) => cleanupUploads(req));
