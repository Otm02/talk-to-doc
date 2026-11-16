import "server-only";

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Body is larger than ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a stream into one buffer and stops as soon as it passes `maxBytes`,
 * cancelling the source. Counts real bytes, so a missing or lying
 * Content-Length cannot get a large body into memory.
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * The first `maxBytes` of a body as text, and no more of it ever read: the
 * source is cancelled as soon as the cap is reached, so a hostile or broken
 * upstream cannot make an error path buffer megabytes. For bodies that are
 * only looked at (an error from an API), where a cut-off is fine.
 */
export async function readTextPrefix(
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(
        value.byteLength > maxBytes - total
          ? value.subarray(0, maxBytes - total)
          : value,
      );
      total += Math.min(value.byteLength, maxBytes - total);
    }
    // More may be coming: tell the source we are done with it.
    if (total >= maxBytes) await reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}
