import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfFixture } from "@test/fixtures";
import { IngestLineSchema, type IngestLine } from "@/lib/wire/ingest";
import { readNdjson } from "@/lib/wire/ndjson";
import { resetEnvCacheForTests } from "@/server/env";
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
vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>();
  return { ...actual, get: vi.fn(), del: vi.fn() };
});

import { del, get } from "@vercel/blob";
import { POST } from "./route";

const TOKEN = "vercel_blob_rw_teststore123_secretpart";
const BLOB_URL =
  "https://teststore123.private.blob.vercel-storage.com/uploads/report-Ab12Cd.pdf";
const IP = { "x-forwarded-for": "203.0.113.5" };

const getMock = vi.mocked(get);
const delMock = vi.mocked(del);

function blobResult(bytes: Uint8Array, size = bytes.length) {
  return {
    statusCode: 200 as const,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers(),
    blob: {
      url: BLOB_URL,
      downloadUrl: BLOB_URL,
      pathname: "uploads/report-Ab12Cd.pdf",
      contentDisposition: "",
      cacheControl: "",
      uploadedAt: new Date(),
      etag: "e",
      contentType: "application/pdf",
      size,
    },
  };
}

function ingest(body: unknown, headers: Record<string, string> = IP): Request {
  return new Request("http://localhost/api/ingest/pdf", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readLines(res: Response): Promise<IngestLine[]> {
  if (!res.body) throw new Error("no body");
  const out: IngestLine[] = [];
  for await (const line of readNdjson(res.body, IngestLineSchema))
    out.push(line);
  return out;
}

beforeEach(() => {
  holder.state = createMemoryAdapters();
  getMock.mockReset();
  delMock.mockReset();
  delMock.mockResolvedValue(undefined);
  vi.stubEnv("UPLOAD_MODE", "blob");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
  resetEnvCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe("POST /api/ingest/pdf, blob mode", () => {
  it("downloads the blob, extracts it, streams the pages and deletes the blob", async () => {
    getMock.mockResolvedValue(blobResult(pdfFixture("multi-page.pdf")));
    const res = await POST(ingest({ blobUrl: BLOB_URL, fileName: "q3.pdf" }));

    expect(res.status).toBe(200);
    const lines = await readLines(res);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatchObject({
      title: "Quarterly Report 2026",
      pages: 4,
    });
    expect(lines.at(-1)).toMatchObject({ done: true, stats: { pages: 4 } });

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith(
      BLOB_URL,
      expect.objectContaining({ access: "private", token: TOKEN }),
    );
    expect(delMock).toHaveBeenCalledTimes(1);
    expect(delMock).toHaveBeenCalledWith(
      BLOB_URL,
      expect.objectContaining({ token: TOKEN }),
    );
  });

  it("deletes the blob as soon as its bytes are in memory, before extraction starts", async () => {
    getMock.mockResolvedValue(blobResult(pdfFixture("multi-page.pdf")));
    const res = await POST(ingest({ blobUrl: BLOB_URL }));
    // The response has not been read at all yet: no page has been extracted.
    expect(delMock).toHaveBeenCalledTimes(1);
    await res.body?.cancel();
  });

  it("uses the file name from the request when the PDF has no title", async () => {
    getMock.mockResolvedValue(blobResult(pdfFixture("hyphenation.pdf")));
    const res = await POST(
      ingest({ blobUrl: BLOB_URL, fileName: "Field Notes.pdf" }),
    );
    const [meta] = await readLines(res);
    expect(meta).toMatchObject({ title: "Field Notes" });
  });

  describe("the blob is deleted when it fails, too", () => {
    const cases: Array<[string, () => void, number, string]> = [
      [
        "it is not a PDF",
        () =>
          getMock.mockResolvedValue(blobResult(pdfFixture("renamed-text.pdf"))),
        415,
        "pdf_not_pdf",
      ],
      [
        "it is empty",
        () => getMock.mockResolvedValue(blobResult(new Uint8Array(0))),
        400,
        "pdf_empty",
      ],
      [
        "it is damaged",
        () =>
          getMock.mockResolvedValue(blobResult(pdfFixture("corrupted.pdf"))),
        422,
        "pdf_corrupted",
      ],
      [
        "it is password-protected",
        () =>
          getMock.mockResolvedValue(blobResult(pdfFixture("encrypted.pdf"))),
        422,
        "pdf_encrypted",
      ],
      [
        "it is over 25 MB",
        () =>
          getMock.mockResolvedValue(
            blobResult(new Uint8Array(10), 26 * 1024 * 1024),
          ),
        413,
        "pdf_too_large",
      ],
      [
        "it is gone",
        () => getMock.mockResolvedValue(null),
        404,
        "upload_missing",
      ],
      [
        "storage fails",
        () => getMock.mockRejectedValue(new Error("503 from storage")),
        502,
        "upstream_failed",
      ],
    ];
    it.each(cases)("when %s", async (_name, arrange, status, code) => {
      arrange();
      const res = await POST(ingest({ blobUrl: BLOB_URL }));
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
      expect(delMock).toHaveBeenCalledTimes(1);
      expect(delMock).toHaveBeenCalledWith(BLOB_URL, expect.anything());
    });
  });

  it("deletes the blob when a scan fails mid-stream", async () => {
    getMock.mockResolvedValue(blobResult(pdfFixture("image-only.pdf")));
    const res = await POST(ingest({ blobUrl: BLOB_URL }));
    const lines = await readLines(res);
    expect(lines.at(-1)).toMatchObject({ error: { code: "pdf_no_text" } });
    expect(delMock).toHaveBeenCalledTimes(1);
  });

  it("still serves the document when the delete itself fails", async () => {
    getMock.mockResolvedValue(blobResult(pdfFixture("multi-page.pdf")));
    delMock.mockRejectedValue(new Error("store unavailable"));
    const res = await POST(ingest({ blobUrl: BLOB_URL }));
    expect(res.status).toBe(200);
    const lines = await readLines(res);
    expect(lines.at(-1)).toMatchObject({ done: true });
  });

  describe("the URL must belong to our store", () => {
    it.each([
      [
        "another store",
        "https://otherstore.private.blob.vercel-storage.com/uploads/a.pdf",
      ],
      ["another host", "https://example.com/uploads/a.pdf"],
      [
        "a path outside uploads/",
        "https://teststore123.private.blob.vercel-storage.com/secrets/a.pdf",
      ],
      ["an internal address", "http://169.254.169.254/latest/meta-data/"],
    ])("refuses %s without calling Blob", async (_name, blobUrl) => {
      const res = await POST(ingest({ blobUrl }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toEqual({
        code: "upload_rejected",
        message: "This upload wasn't allowed. Try again.",
      });
      expect(getMock).not.toHaveBeenCalled();
      expect(delMock).not.toHaveBeenCalled();
    });
  });

  describe("bad requests never reach Blob", () => {
    it.each([
      ["not JSON", "{nope"],
      ["no blobUrl", {}],
      ["an unknown field", { blobUrl: BLOB_URL, extra: 1 }],
      ["a non-string URL", { blobUrl: 5 }],
      [
        "a huge URL",
        {
          blobUrl: `https://teststore123.private.blob.vercel-storage.com/uploads/${"a".repeat(3000)}.pdf`,
        },
      ],
    ])("%s", async (_name, body) => {
      const res = await POST(ingest(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
      expect(getMock).not.toHaveBeenCalled();
      expect(delMock).not.toHaveBeenCalled();
    });

    it("a multipart upload in blob mode", async () => {
      const form = new FormData();
      form.set("file", new File([pdfFixture("multi-page.pdf")], "a.pdf"));
      const res = await POST(
        new Request("http://localhost/api/ingest/pdf", {
          method: "POST",
          headers: IP,
          body: form,
        }),
      );
      expect(res.status).toBe(400);
      expect(getMock).not.toHaveBeenCalled();
    });
  });

  it("limits requests per client before touching Blob", async () => {
    getMock.mockResolvedValue(null);
    for (let i = 0; i < 10; i++) await POST(ingest({ blobUrl: BLOB_URL }));
    getMock.mockClear();
    delMock.mockClear();
    const res = await POST(ingest({ blobUrl: BLOB_URL }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(getMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it("never exposes the token or SDK messages in an error", async () => {
    getMock.mockRejectedValue(new Error(`request failed with ${TOKEN}`));
    const res = await POST(ingest({ blobUrl: BLOB_URL }));
    const text = await res.text();
    expect(text).not.toContain("secretpart");
    expect(text).not.toContain("request failed");
  });
});
