import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IngestLineSchema, type IngestLine } from "./ingest";
import { NdjsonError, encodeNdjsonLine, readNdjson } from "./ndjson";

const bytes = (s: string) => new TextEncoder().encode(s);

/** A stream that yields the given chunks one by one. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const Any = z.looseObject({});

describe("encodeNdjsonLine", () => {
  it("is one JSON object and a newline", () => {
    expect(encodeNdjsonLine({ page: 1, text: "a\nb" })).toBe(
      '{"page":1,"text":"a\\nb"}\n',
    );
  });
});

describe("readNdjson", () => {
  it("reads one object per line", async () => {
    const stream = streamOf([bytes('{"a":1}\n{"a":2}\n')]);
    expect(await collect(readNdjson(stream, Any))).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("joins a line that arrives in several chunks", async () => {
    const stream = streamOf([
      bytes('{"te'),
      bytes('xt":"hel'),
      bytes('lo"}\n'),
    ]);
    expect(await collect(readNdjson(stream, Any))).toEqual([{ text: "hello" }]);
  });

  it("handles several lines in one chunk and a split between them", async () => {
    const stream = streamOf([bytes('{"a":1}\n{"a"'), bytes(':2}\n{"a":3}\n')]);
    expect(await collect(readNdjson(stream, Any))).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  it("keeps a multi-byte character that is split across chunks", async () => {
    // "é" is two bytes, "—" three, "😀" four: cut each in the middle.
    const whole = bytes('{"text":"é—😀"}\n');
    const cuts = [11, 13, 17];
    const chunks: Uint8Array[] = [];
    let from = 0;
    for (const cut of cuts) {
      chunks.push(whole.slice(from, cut));
      from = cut;
    }
    chunks.push(whole.slice(from));
    const out = await collect(readNdjson(streamOf(chunks), Any));
    expect(out).toEqual([{ text: "é—😀" }]);
  });

  it("reads a final line that has no newline and skips blank lines", async () => {
    const stream = streamOf([bytes('\n{"a":1}\n\n{"a":2}')]);
    expect(await collect(readNdjson(stream, Any))).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("accepts CRLF line endings", async () => {
    const stream = streamOf([bytes('{"a":1}\r\n{"a":2}\r\n')]);
    expect(await collect(readNdjson(stream, Any))).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("throws NdjsonError with the line number on bad JSON", async () => {
    const stream = streamOf([bytes('{"a":1}\nnot json\n')]);
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const item of readNdjson(stream, Any)) seen.push(item);
      })(),
    ).rejects.toMatchObject({ name: "NdjsonError", line: 2 });
    expect(seen).toEqual([{ a: 1 }]); // lines before the bad one still arrive
  });

  it("throws NdjsonError when a line fails the schema", async () => {
    const stream = streamOf([bytes('{"page":"one","text":1}\n')]);
    await expect(collect(readNdjson(stream, IngestLineSchema))).rejects.toThrow(
      NdjsonError,
    );
  });

  it("does not echo the offending content in the error", async () => {
    const stream = streamOf([bytes("secret-looking garbage\n")]);
    await expect(collect(readNdjson(stream, Any))).rejects.not.toThrow(
      /secret-looking/,
    );
  });

  it("cancels the source when the consumer stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes('{"a":1}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const item of readNdjson(stream, Any)) {
      expect(item).toEqual({ a: 1 });
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("IngestLineSchema", () => {
  const lines: IngestLine[] = [
    { documentId: "d1", title: "T", sourceType: "pdf", pages: 2 },
    { page: 1, text: "hello" },
    { done: true, stats: { pages: 2, words: 10, tokens: 14 }, coverage: 0.5 },
    { error: { code: "pdf_timeout", message: "Too slow." } },
  ];

  it.each(lines.map((l) => [Object.keys(l)[0], l] as const))(
    "accepts a %s line",
    (_key, line) => {
      expect(IngestLineSchema.parse(line)).toEqual(line);
    },
  );

  it("rejects unknown keys and out-of-range values", () => {
    expect(
      IngestLineSchema.safeParse({ page: 1, text: "x", extra: 1 }).success,
    ).toBe(false);
    expect(
      IngestLineSchema.safeParse({
        done: true,
        stats: { pages: 1, words: 1, tokens: 1 },
        coverage: 1.5,
      }).success,
    ).toBe(false);
    expect(IngestLineSchema.safeParse({ page: 0, text: "x" }).success).toBe(
      false,
    );
  });
});
