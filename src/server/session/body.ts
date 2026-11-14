import "server-only";
import { BodyTooLargeError, readStreamCapped } from "../ingest/pdf/read-capped";

export class ReadFailure extends Error {
  constructor(readonly reason: "too_large" | "not_json") {
    super(`Could not read request body: ${reason}`);
    this.name = "ReadFailure";
  }
}

/** Reads a JSON body, counting real bytes so a missing Content-Length does not matter. */
export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<unknown> {
  if (!req.body) throw new ReadFailure("not_json");
  let bytes: Uint8Array;
  try {
    bytes = await readStreamCapped(req.body, maxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new ReadFailure("too_large");
    throw err;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ReadFailure("not_json");
  }
}
