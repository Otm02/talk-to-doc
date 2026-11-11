import { handle } from "@/server/http";
import { issueUploadToken } from "@/server/ingest/pdf/upload-token";

export const POST = handle((req) => issueUploadToken(req));
