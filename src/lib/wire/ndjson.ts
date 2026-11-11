import type { ZodType } from "zod";

export class NdjsonError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "NdjsonError";
  }
}

export function encodeNdjsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Reads newline-delimited JSON from a byte stream and validates every line.
 * Chunks may split a line, or a multi-byte character, anywhere. A last line
 * without a trailing newline is still read. Throws NdjsonError on bad JSON or a
 * line that fails the schema; the caller decides what a missing `done` means.
 */
export async function* readNdjson<T>(
  stream: ReadableStream<Uint8Array>,
  schema: ZodType<T>,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let lineNumber = 0;

  const parse = (raw: string): T => {
    lineNumber += 1;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new NdjsonError("Line is not valid JSON", lineNumber);
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new NdjsonError(
        "Line does not match the expected shape",
        lineNumber,
      );
    }
    return result.data;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (raw) yield parse(raw);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) yield parse(rest);
  } finally {
    // Also runs when the consumer stops early, which cancels the request body.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
