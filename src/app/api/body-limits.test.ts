import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BLOB_INGEST_BODY_BYTES,
  MAX_UPLOAD_TOKEN_BODY_BYTES,
  MAX_YOUTUBE_BODY_BYTES,
} from "@/server/body";
import { resetEnvCacheForTests } from "@/server/env";
import type { StateAdapters } from "@/server/state";
import { createMemoryAdapters } from "@/server/state/memory";
import { MAX_SESSION_BODY_BYTES } from "@/server/session/limits";

// T-13: every route that reads JSON stops reading at its own byte cap, before
// parsing and before any upstream call. The padding is whitespace, so the
// body is valid JSON of the right shape: only its size is wrong.

const holder = vi.hoisted(() => ({
  state: undefined as StateAdapters | undefined,
}));
vi.mock("@/server/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/state")>()),
  getState: () => {
    if (!holder.state) throw new Error("test state not set");
    return holder.state;
  },
}));
const handleUpload = vi.hoisted(() => vi.fn());
vi.mock("@vercel/blob/client", () => ({ handleUpload }));

import { POST as ingestPdf } from "./ingest/pdf/route";
import { POST as ingestYoutube } from "./ingest/youtube/route";
import { POST as session } from "./realtime/session/route";
import { POST as uploadToken } from "./upload/token/route";

const UUID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "vercel_blob_rw_teststore_secret";

interface Case {
  name: string;
  call: (req: Request) => Promise<Response>;
  path: string;
  json: unknown;
  cap: number;
}

const CASES: Case[] = [
  {
    name: "session",
    call: session,
    path: "realtime/session",
    json: { documentId: UUID },
    cap: MAX_SESSION_BODY_BYTES,
  },
  {
    name: "ingest/youtube",
    call: ingestYoutube,
    path: "ingest/youtube",
    json: { url: "https://youtu.be/dQw4w9WgXcQ" },
    cap: MAX_YOUTUBE_BODY_BYTES,
  },
  {
    name: "ingest/pdf (blob mode)",
    call: ingestPdf,
    path: "ingest/pdf",
    json: {
      blobUrl:
        "https://teststore.private.blob.vercel-storage.com/uploads/a.pdf",
    },
    cap: MAX_BLOB_INGEST_BODY_BYTES,
  },
  {
    name: "upload/token",
    call: uploadToken,
    path: "upload/token",
    json: {
      type: "blob.generate-client-token",
      payload: {
        pathname: "uploads/a.pdf",
        clientPayload: null,
        multipart: false,
      },
    },
    cap: MAX_UPLOAD_TOKEN_BODY_BYTES,
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
let ipCounter = 0;

function request(c: Case, body: string): Request {
  ipCounter += 1;
  return new Request(`https://app.test/api/${c.path}`, {
    method: "POST",
    headers: { "x-forwarded-for": `198.51.100.${ipCounter}` },
    body,
  });
}
const padded = (json: unknown, bytes: number) =>
  JSON.stringify(json) + " ".repeat(bytes);

beforeEach(() => {
  holder.state = createMemoryAdapters();
  vi.stubEnv("UPLOAD_MODE", "blob");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
  for (const name of ["VERCEL", "VERCEL_ENV", "VOICE_ENABLED"]) {
    vi.stubEnv(name, "");
  }
  resetEnvCacheForTests();
  fetchMock = vi.fn(
    async () => new Response("no network in this test", { status: 500 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  handleUpload.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe.each(CASES)("$name", (c) => {
  it("refuses a body over its cap as invalid_request, before any upstream call", async () => {
    const res = await c.call(request(c, padded(c.json, c.cap)));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handleUpload).not.toHaveBeenCalled();
  });

  it("counts real bytes, not a Content-Length the client can lie about", async () => {
    const req = request(c, padded(c.json, c.cap));
    req.headers.set("content-length", "10");
    const res = await c.call(req);
    expect(res.status).toBe(400);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await c.call(request(c, "not json {"));
    expect(res.status).toBe(400);
  });

  it("refuses an empty body", async () => {
    const res = await c.call(
      new Request(`https://app.test/api/${c.path}`, {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.250" },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("the caps are small and sensible", () => {
  it("leave plenty of room for real requests", () => {
    expect(MAX_YOUTUBE_BODY_BYTES).toBeGreaterThan(2048 + 200); // url max + field names
    expect(MAX_BLOB_INGEST_BODY_BYTES).toBeGreaterThan(2048 + 255 + 100);
    expect(MAX_UPLOAD_TOKEN_BODY_BYTES).toBeGreaterThan(256 + 1024 + 200);
    expect(MAX_SESSION_BODY_BYTES).toBeLessThan(1024 * 1024);
  });
});
