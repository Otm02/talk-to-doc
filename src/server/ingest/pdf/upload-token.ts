import "server-only";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { z } from "zod";
import { EnvError, getEnv } from "../../env";
import { AppError, catalogError } from "../../errors";
import { parseWith } from "../../http";
import { enforceRateLimit } from "../../security/rate-limit";
import {
  BLOB_TOKEN_TTL_MS,
  MAX_PDF_BYTES,
  UPLOAD_PATHNAME,
  UPLOAD_TOKEN_RATE,
} from "./limits";

// Only token requests are accepted. The SDK's other event, upload-completed,
// is a webhook we never register (it cannot reach localhost or protected
// previews), so a request claiming to be one is refused outright.
const TokenRequestSchema = z.object({
  type: z.literal("blob.generate-client-token"),
  payload: z.object({
    pathname: z.string().min(1).max(256),
    clientPayload: z.string().max(1024).nullable(),
    multipart: z.boolean(),
  }),
});

/** POST /api/upload/token: lets the browser upload one PDF straight to Blob. */
export async function issueUploadToken(req: Request): Promise<Response> {
  const env = getEnv();
  if (env.uploadMode !== "blob") {
    throw new AppError("not_found", "Not found.", 404);
  }
  if (!env.blobToken) {
    throw new EnvError([
      "BLOB_READ_WRITE_TOKEN is required when UPLOAD_MODE=blob",
    ]);
  }
  const token = env.blobToken;

  await enforceRateLimit(req, "upload-token", UPLOAD_TOKEN_RATE);
  const parsed = parseWith(
    TokenRequestSchema,
    await req.json().catch(() => {
      throw catalogError("invalid_request");
    }),
  );

  try {
    const result = await handleUpload({
      token, // explicit: the SDK would otherwise read process.env itself
      request: req,
      // Validated above; the SDK's own type is the same shape.
      body: parsed satisfies HandleUploadBody,
      onBeforeGenerateToken: async (pathname) => {
        // We have no accounts, so the limits live in the token itself: Blob
        // enforces the type and size, and the token is short-lived.
        if (!UPLOAD_PATHNAME.test(pathname))
          throw catalogError("upload_rejected");
        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: MAX_PDF_BYTES,
          addRandomSuffix: true,
          allowOverwrite: false,
          validUntil: Date.now() + BLOB_TOKEN_TTL_MS,
        };
      },
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw catalogError("upload_rejected", { cause: err });
  }
}
