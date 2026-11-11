import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>();
  return { ...actual, get: vi.fn(), del: vi.fn() };
});

import { BlobNotFoundError, del, get } from "@vercel/blob";
import { MAX_PDF_BYTES } from "./limits";
import { deleteBlob, parseOwnBlobUrl, readBlob, type OwnBlob } from "./blob";

const TOKEN = "vercel_blob_rw_TestStore123_secretpart";
const URL_OK =
  "https://teststore123.private.blob.vercel-storage.com/uploads/report-Ab12Cd.pdf";

const getMock = vi.mocked(get);
const delMock = vi.mocked(del);

const own: OwnBlob = { url: URL_OK, access: "private" };

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

function found(stream: ReadableStream<Uint8Array>, size: number) {
  return {
    statusCode: 200 as const,
    stream,
    headers: new Headers(),
    blob: {
      url: URL_OK,
      downloadUrl: URL_OK,
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

beforeEach(() => {
  getMock.mockReset();
  delMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("parseOwnBlobUrl", () => {
  it("accepts a private and a public URL of our store, ignoring case", () => {
    expect(parseOwnBlobUrl(URL_OK, TOKEN)).toEqual({
      url: URL_OK,
      access: "private",
    });
    expect(
      parseOwnBlobUrl(
        "https://TESTSTORE123.public.blob.vercel-storage.com/uploads/a.pdf",
        TOKEN,
      ),
    ).toEqual({
      url: "https://teststore123.public.blob.vercel-storage.com/uploads/a.pdf",
      access: "public",
    });
  });

  it.each([
    [
      "another store",
      "https://otherstore.private.blob.vercel-storage.com/uploads/a.pdf",
    ],
    [
      "plain http",
      "http://teststore123.private.blob.vercel-storage.com/uploads/a.pdf",
    ],
    ["a foreign host", "https://evil.example.com/uploads/a.pdf"],
    [
      "a look-alike suffix",
      "https://teststore123.private.blob.vercel-storage.com.evil.com/uploads/a.pdf",
    ],
    [
      "our host in the path",
      "https://evil.example.com/teststore123.private.blob.vercel-storage.com/uploads/a.pdf",
    ],
    [
      "userinfo",
      "https://teststore123.private.blob.vercel-storage.com@evil.com/uploads/a.pdf",
    ],
    [
      "a port",
      "https://teststore123.private.blob.vercel-storage.com:8443/uploads/a.pdf",
    ],
    [
      "a path outside uploads/",
      "https://teststore123.private.blob.vercel-storage.com/other/a.pdf",
    ],
    [
      "a nested path",
      "https://teststore123.private.blob.vercel-storage.com/uploads/x/a.pdf",
    ],
    [
      "the uploads/ root only",
      "https://teststore123.private.blob.vercel-storage.com/uploads/",
    ],
    [
      "a non-PDF name",
      "https://teststore123.private.blob.vercel-storage.com/uploads/a.exe",
    ],
    [
      "path traversal",
      "https://teststore123.private.blob.vercel-storage.com/uploads/../secret.pdf",
    ],
    [
      "encoded traversal",
      "https://teststore123.private.blob.vercel-storage.com/uploads/%2e%2e%2fsecret.pdf",
    ],
    [
      "a query string",
      "https://teststore123.private.blob.vercel-storage.com/uploads/a.pdf?x=1",
    ],
    [
      "a fragment",
      "https://teststore123.private.blob.vercel-storage.com/uploads/a.pdf#x",
    ],
    ["a bare pathname", "uploads/a.pdf"],
    ["an empty string", ""],
    ["garbage", "not a url at all"],
    ["a javascript URL", "javascript:alert(1)"],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseOwnBlobUrl(raw, TOKEN)).toThrowError(
      expect.objectContaining({ code: "upload_rejected", httpStatus: 400 }),
    );
  });

  it("refuses everything when the token has no store id", () => {
    expect(() => parseOwnBlobUrl(URL_OK, "not-a-blob-token")).toThrowError(
      expect.objectContaining({ code: "upload_rejected" }),
    );
  });
});

describe("readBlob", () => {
  const far = () => Date.now() + 30_000;

  it("downloads the bytes with the explicit token and the URL's access", async () => {
    getMock.mockResolvedValue(
      found(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 3),
    );
    const bytes = await readBlob(own, TOKEN, far());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(getMock).toHaveBeenCalledWith(
      URL_OK,
      expect.objectContaining({
        access: "private",
        token: TOKEN,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports a missing blob as upload_missing", async () => {
    getMock.mockResolvedValue(null);
    await expect(readBlob(own, TOKEN, far())).rejects.toMatchObject({
      code: "upload_missing",
      httpStatus: 404,
      userMessage: "We couldn't find your upload. Upload it again.",
    });
  });

  it("treats a 304 or a thrown not-found the same way", async () => {
    getMock.mockResolvedValueOnce({
      statusCode: 304,
      stream: null,
      headers: new Headers(),
      blob: {
        url: URL_OK,
        downloadUrl: URL_OK,
        pathname: "p",
        contentDisposition: "",
        cacheControl: "",
        uploadedAt: new Date(),
        etag: "e",
        contentType: null,
        size: null,
      },
    });
    await expect(readBlob(own, TOKEN, far())).rejects.toMatchObject({
      code: "upload_missing",
    });
    getMock.mockRejectedValueOnce(new BlobNotFoundError());
    await expect(readBlob(own, TOKEN, far())).rejects.toMatchObject({
      code: "upload_missing",
    });
  });

  it("refuses by the reported size without reading the body", async () => {
    const stream = streamOf(new Uint8Array(10));
    const cancel = vi.spyOn(stream, "cancel");
    getMock.mockResolvedValue(found(stream, MAX_PDF_BYTES + 1));
    await expect(readBlob(own, TOKEN, far())).rejects.toMatchObject({
      code: "pdf_too_large",
      httpStatus: 413,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("also stops when the body is bigger than the reported size", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    getMock.mockResolvedValue(found(stream, 1000)); // lies about its size
    await expect(readBlob(own, TOKEN, far())).rejects.toMatchObject({
      code: "pdf_too_large",
    });
    expect(pulled).toBeLessThanOrEqual(27); // stops at 25 MB, not at the end of the source
  });

  it("turns SDK failures into a generic 502 and hides the SDK message", async () => {
    const failure = new Error(`503 from storage, token ${TOKEN}`);
    getMock.mockRejectedValue(failure);
    const err = await readBlob(own, TOKEN, far()).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "upstream_failed",
      httpStatus: 502,
      userMessage: "We couldn't read your upload. Try again.",
      cause: failure,
    });
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it("gives up with pdf_timeout when the deadline passes during the download", async () => {
    getMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );
    await expect(readBlob(own, TOKEN, Date.now() + 30)).rejects.toMatchObject({
      code: "pdf_timeout",
      httpStatus: 504,
    });
  });
});

describe("deleteBlob", () => {
  it("deletes by URL with the explicit token", async () => {
    delMock.mockResolvedValue(undefined);
    await deleteBlob(own, TOKEN);
    expect(delMock).toHaveBeenCalledWith(
      URL_OK,
      expect.objectContaining({
        token: TOKEN,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("swallows a failure and logs only the path", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delMock.mockRejectedValue(new Error(`boom ${TOKEN}`));
    await expect(deleteBlob(own, TOKEN)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "[blob] delete failed",
      "/uploads/report-Ab12Cd.pdf",
      expect.any(Error),
    );
    expect(log.mock.calls[0]?.[1]).not.toContain("teststore");
  });
});
