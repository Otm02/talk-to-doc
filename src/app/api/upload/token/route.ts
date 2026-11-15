// A token mint is one rate-limit check and one Blob SDK call.
export const maxDuration = 15;

import { handle } from "@/server/http";
import { issueUploadToken } from "@/server/ingest/pdf/upload-token";

export const POST = handle("upload-token", (req) => issueUploadToken(req));
