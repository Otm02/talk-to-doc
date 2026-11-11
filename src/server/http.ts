import "server-only";
import type { ZodType } from "zod";
import { toErrorResult } from "./errors";

type Handler = (
  req: Request,
  requestId: string,
) => Promise<Response> | Response;

/** Thin wrapper for route handlers: request id, error mapping, server-side log. */
export function handle(handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    try {
      const res = await handler(req, requestId);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      const { status, body } = toErrorResult(err, requestId);
      // Details stay in server logs; the client gets the mapped body only.
      console.error(`[${requestId}] ${body.error.code}`, err);
      return Response.json(body, {
        status,
        headers: { "x-request-id": requestId, "cache-control": "no-store" },
      });
    }
  };
}

export function parseWith<T>(schema: ZodType<T>, input: unknown): T {
  return schema.parse(input);
}
