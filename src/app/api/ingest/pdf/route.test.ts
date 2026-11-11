import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfFixture } from "@test/fixtures";
import { buildBlankPages } from "../../../../../scripts/make-fixtures";
import { IngestLineSchema, type IngestLine } from "@/lib/wire/ingest";
import { readNdjson } from "@/lib/wire/ndjson";
import { resetEnvCacheForTests } from "@/server/env";
import type { PdfDocumentRecord } from "@/server/ingest/record";
import { createMemoryAdapters } from "@/server/state/memory";
import type { StateAdapters } from "@/server/state";

const holder = vi.hoisted(() => ({
  state: undefined as StateAdapters | undefined,
}));
vi.mock("@/server/state", () => ({
  getState: () => {
    if (!holder.state) throw new Error("test state not set");
    return holder.state;
  },
}));

import { POST, maxDuration } from "./route";

const IP = { "x-forwarded-for": "203.0.113.5" };

function upload(
  bytes: Uint8Array<ArrayBuffer>,
  options: {
    name?: string;
    headers?: Record<string, string>;
    field?: string;
  } = {},
): Request {
  const form = new FormData();
  form.set(
    options.field ?? "file",
    new File([bytes], options.name ?? "upload.pdf", {
      type: "application/pdf",
    }),
  );
  return new Request("http://localhost/api/ingest/pdf", {
    method: "POST",
    headers: { ...IP, ...options.headers },
    body: form,
  });
}

async function readLines(res: Response): Promise<IngestLine[]> {
  if (!res.body) throw new Error("no body");
  const out: IngestLine[] = [];
  for await (const line of readNdjson(res.body, IngestLineSchema))
    out.push(line);
  return out;
}

async function expectError(
  res: Response,
  status: number,
  code: string,
  message?: string,
) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = await res.json();
  expect(body.error.code).toBe(code);
  if (message) expect(body.error.message).toBe(message);
  expect(typeof body.requestId).toBe("string");
  return body;
}

beforeEach(() => {
  holder.state = createMemoryAdapters();
  resetEnvCacheForTests();
  // The route logs every refusal with its request id; keep test output readable.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe("route config", () => {
  it("allows 60 seconds", () => {
    expect(maxDuration).toBe(60);
  });
});

describe("POST /api/ingest/pdf, direct mode: happy path", () => {
  it("streams meta, every page, then done, and saves the document", async () => {
    const res = await POST(
      upload(pdfFixture("multi-page.pdf"), { name: "q3.pdf" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();

    const lines = await readLines(res);
    expect(lines).toHaveLength(6);
    const [meta, ...rest] = lines;
    expect(meta).toMatchObject({
      title: "Quarterly Report 2026", // from the PDF, not the file name
      sourceType: "pdf",
      pages: 4,
    });
    expect(rest.slice(0, 4).map((l) => ("page" in l ? l.page : null))).toEqual([
      1, 2, 3, 4,
    ]);
    const done = rest[4];
    expect(done).toMatchObject({
      done: true,
      stats: { pages: 4 },
      coverage: 1,
    });

    const documentId = meta && "documentId" in meta ? meta.documentId : "";
    const record = (await holder.state?.documents.get(
      documentId,
    )) as PdfDocumentRecord | null;
    expect(record).toMatchObject({
      id: documentId,
      sourceType: "pdf",
      title: "Quarterly Report 2026",
      coverage: 1,
      stats: done && "stats" in done ? done.stats : undefined,
    });
    expect(record?.context).toContain("--- Page 1 ---\nQuarterly Report");
    expect(record?.context).toContain("--- Page 4 ---\nAppendix");
    expect(record?.stats.tokens).toBeGreaterThan(50);
  });

  it("uses the file name when the PDF has no title", async () => {
    const res = await POST(
      upload(pdfFixture("hyphenation.pdf"), { name: "My Notes.pdf" }),
    );
    const [meta] = await readLines(res);
    expect(meta).toMatchObject({ title: "My Notes" });
  });

  it("sends clean text: accents kept, words rejoined", async () => {
    const french = await readLines(
      await POST(upload(pdfFixture("french.pdf"))),
    );
    expect(french[1]).toMatchObject({
      text: expect.stringContaining("Résumé : l’œuvre de François Mauriac"),
    });
    const hyphen = await readLines(
      await POST(upload(pdfFixture("hyphenation.pdf"))),
    );
    expect(hyphen[1]).toMatchObject({
      text: expect.stringContaining("The information was transmitted"),
    });
  });

  it("extracts a file that only has an owner password", async () => {
    const lines = await readLines(
      await POST(upload(pdfFixture("owner-only.pdf"))),
    );
    expect(lines.at(-1)).toMatchObject({ done: true });
  });

  it("accepts a PDF with an empty page among text pages", async () => {
    const lines = await readLines(
      await POST(upload(pdfFixture("partial-text.pdf"))),
    );
    expect(
      lines
        .map((l) => ("page" in l ? l.text.length > 0 : null))
        .filter((v) => v !== null),
    ).toEqual([true, false, true]);
    expect(lines.at(-1)).toMatchObject({ done: true, stats: { pages: 3 } });
  });
});

describe("413: too large", () => {
  const CHUNK = 1024 * 1024;

  it("stops reading a body that keeps coming and never trusts Content-Length", async () => {
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(CHUNK));
        if (pulled >= 200) controller.close(); // would be 200 MB
      },
    });
    const req = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      headers: { ...IP, "content-type": "multipart/form-data; boundary=x" }, // no content-length
      body: source,
      duplex: "half",
    } as RequestInit);
    const res = await POST(req);
    await expectError(
      res,
      413,
      "pdf_too_large",
      "This PDF is over 25 MB. Try a smaller file.",
    );
    expect(pulled).toBeLessThan(30); // gave up at about 25 MB, did not read it all
  });

  it("refuses a declared size that is already too big, before reading", async () => {
    let pulled = 0;
    const req = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      headers: {
        ...IP,
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(60 * CHUNK),
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(10));
        },
      }),
      duplex: "half",
    } as RequestInit);
    const res = await POST(req);
    await expectError(res, 413, "pdf_too_large");
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("counts the file's real bytes: one byte over 25 MB is refused", async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode("%PDF-1.4\n"));
    const res = await POST(upload(big));
    await expectError(res, 413, "pdf_too_large");
  });

  it("lets exactly 25 MB through the size guard", async () => {
    const exact = new Uint8Array(25 * 1024 * 1024);
    exact.set(new TextEncoder().encode("%PDF-1.4\n"));
    // Past the size guard it is just a broken file, not a "too large" one.
    const res = await POST(upload(exact));
    await expectError(res, 422, "pdf_corrupted");
  });
});

describe("415: not a PDF", () => {
  it("refuses a text file renamed to .pdf", async () => {
    const res = await POST(
      upload(pdfFixture("renamed-text.pdf"), { name: "notes.pdf" }),
    );
    await expectError(
      res,
      415,
      "pdf_not_pdf",
      "This file isn't a PDF. Choose a .pdf file.",
    );
  });

  it("ignores the claimed type and the file name", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
    ]);
    const res = await POST(upload(png, { name: "photo.pdf" }));
    await expectError(res, 415, "pdf_not_pdf");
  });

  it("accepts a real PDF whatever it is called", async () => {
    const res = await POST(
      upload(pdfFixture("multi-page.pdf"), { name: "data.bin" }),
    );
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});

describe("429: rate limit", () => {
  it("allows 10 a minute per client, then answers 429 with Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(upload(pdfFixture("renamed-text.pdf")));
      expect(res.status).toBe(415); // reached the guards, so not limited
    }
    const limited = await POST(upload(pdfFixture("multi-page.pdf")));
    await expectError(
      limited,
      429,
      "rate_limited",
      "Too many tries. Wait a minute and try again.",
    );
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("does not read the body of a limited request", async () => {
    for (let i = 0; i < 10; i++)
      await POST(upload(pdfFixture("renamed-text.pdf")));
    const req = upload(pdfFixture("multi-page.pdf"));
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(req.bodyUsed).toBe(false); // refused before a single byte was read
  });

  it("counts clients separately", async () => {
    for (let i = 0; i < 10; i++)
      await POST(upload(pdfFixture("renamed-text.pdf")));
    const other = await POST(
      upload(pdfFixture("renamed-text.pdf"), {
        headers: { "x-forwarded-for": "198.51.100.7" },
      }),
    );
    expect(other.status).toBe(415);
  });
});

describe("other refusals come as JSON with a status, before any stream", () => {
  it("zero bytes: 400 pdf_empty", async () => {
    await expectError(
      await POST(upload(new Uint8Array(0))),
      400,
      "pdf_empty",
      "This file is empty.",
    );
  });

  it("password-protected: 422 pdf_encrypted", async () => {
    await expectError(
      await POST(upload(pdfFixture("encrypted.pdf"))),
      422,
      "pdf_encrypted",
      "This PDF is password-protected. Remove the password and try again.",
    );
  });

  it("damaged: 422 pdf_corrupted", async () => {
    await expectError(
      await POST(upload(pdfFixture("corrupted.pdf"))),
      422,
      "pdf_corrupted",
      "We couldn't open this PDF. It may be damaged.",
    );
  });

  it("more than 2,000 pages: 422 pdf_too_many_pages", async () => {
    await expectError(
      await POST(upload(buildBlankPages(2001))),
      422,
      "pdf_too_many_pages",
      "This PDF has more than 2,000 pages. Try a shorter one.",
    );
  });

  it("no file field: 400 invalid_request", async () => {
    await expectError(
      await POST(upload(pdfFixture("multi-page.pdf"), { field: "document" })),
      400,
      "invalid_request",
    );
  });

  it("not multipart: 400 invalid_request", async () => {
    const json = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      headers: { ...IP, "content-type": "application/json" },
      body: JSON.stringify({ blobUrl: "https://x" }),
    });
    await expectError(await POST(json), 400, "invalid_request");
    const noBody = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      headers: IP,
    });
    await expectError(await POST(noBody), 400, "invalid_request");
  });

  it("a field that is text, not a file: 400 invalid_request", async () => {
    const form = new FormData();
    form.set("file", "just text");
    const req = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      headers: IP,
      body: form,
    });
    await expectError(await POST(req), 400, "invalid_request");
  });

  it("a multipart body that is cut short: 400 invalid_request", async () => {
    const req = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      headers: { ...IP, "content-type": "multipart/form-data; boundary=zzz" },
      body: '--zzz\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n%PDF-1.4',
    });
    await expectError(await POST(req), 400, "invalid_request");
  });
});

describe("failures after the stream has started", () => {
  it("scanned: pages stream, then an error line, and nothing is saved", async () => {
    const res = await POST(upload(pdfFixture("image-only.pdf")));
    expect(res.status).toBe(200); // the stream had started when the scan check ran
    const lines = await readLines(res);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ pages: 1 });
    expect(lines[1]).toEqual({ page: 1, text: "" });
    expect(lines[2]).toEqual({
      error: {
        code: "pdf_no_text",
        message:
          "This PDF has no selectable text. It may be a scan. Try a PDF with real text.",
      },
    });
    const meta = lines[0];
    const id = meta && "documentId" in meta ? meta.documentId : "";
    expect(await holder.state?.documents.get(id)).toBeNull();
  });

  it("a document with no pages ends with the same error", async () => {
    const lines = await readLines(await POST(upload(pdfFixture("empty.pdf"))));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ error: { code: "pdf_no_text" } });
  });
});

describe("configuration", () => {
  it("blob mode without a token is a config error that names the variable only", async () => {
    vi.stubEnv("UPLOAD_MODE", "blob");
    resetEnvCacheForTests();
    const req = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      headers: { ...IP, "content-type": "application/json" },
      body: JSON.stringify({ blobUrl: "https://x" }),
    });
    const body = await expectError(await POST(req), 500, "config_invalid");
    expect(body.error.message).toContain("BLOB_READ_WRITE_TOKEN");
  });
});
