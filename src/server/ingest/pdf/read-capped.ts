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
