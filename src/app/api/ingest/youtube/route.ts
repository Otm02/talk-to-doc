import { handle } from "@/server/http";
import { ingestYoutube } from "@/server/ingest/youtube/request";

// Worst case is Direct (3 s) + Supadata (15 s) + a 30 s job poll, so 60 s is
// enough. No `runtime` or `dynamic` export: both are rejected under
// cacheComponents.
export const maxDuration = 60;

export const POST = handle((req, requestId) => ingestYoutube(req, requestId));
