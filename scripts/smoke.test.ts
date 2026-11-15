import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDF,
  parseArgs,
  runSmoke,
  type SmokeDeps,
  type SmokeOptions,
} from "./smoke";

const SECRET = "ek_live_do-not-print";
const nd = (...lines: object[]) =>
  new Response(lines.map((l) => JSON.stringify(l) + "\n").join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
const err = (status: number, code: string) =>
  Response.json({ error: { code, message: "x" } }, { status });

interface World {
  health?: object;
  blobDeleted?: boolean;
  youtube?: Response;
  session?: Response;
}

function fakeDeps(world: World = {}) {
  const calls: string[] = [];
  const bodies: Record<string, string> = {};
  let ingested = 0;
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (typeof init?.body === "string") bodies[url.pathname] = init.body;
    switch (url.pathname) {
      case "/api/health":
        return Response.json(
          world.health ?? {
            ok: true,
            version: "abc1234",
            uploadMode: "blob",
            state: "upstash",
          },
        );
      case "/api/ingest/pdf":
        ingested += 1;
        if (ingested > 1 && init?.body && typeof init.body === "string") {
          return world.blobDeleted === false
            ? nd({ documentId: "d", title: "t", sourceType: "pdf", pages: 1 })
            : err(404, "upload_missing");
        }
        return nd(
          { documentId: "pdf-doc", title: "t", sourceType: "pdf", pages: 2 },
          { page: 1, text: "a" },
          { page: 2, text: "b" },
          { done: true },
        );
      case "/api/ingest/youtube":
        return (
          world.youtube ??
          nd(
            {
              documentId: "yt-doc",
              sourceType: "youtube",
              provider: "supadata",
            },
            { segment: { startSec: 0, text: "hi" } },
            { done: true },
          )
        );
      case "/api/realtime/session":
        return (
          world.session ??
          Response.json({
            clientSecret: SECRET,
            expiresAt: 1,
            model: "gpt-realtime-2.1-mini",
            maxSessionSeconds: 300,
          })
        );
      default:
        return err(404, "not_found");
    }
  }) as typeof fetch;
  const deps: SmokeDeps = {
    fetch: fetchFake,
    readFile: async () => new Uint8Array([37, 80, 68, 70]),
    uploadToBlob: async () => ({ url: "https://s.private.blob/uploads/x.pdf" }),
    now: () => 0,
  };
  return { deps, calls, bodies };
}

const remote: SmokeOptions = {
  baseUrl: "https://app.example.com/",
  pdfPath: DEFAULT_PDF,
  youtubeUrl: "https://youtu.be/jNQXAC9IVRw",
  session: true,
};

describe("runSmoke", () => {
  it("passes every step on a healthy blob + upstash deploy", async () => {
    const { deps, bodies } = fakeDeps();
    const results = await runSmoke(remote, deps);
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["health", true],
      ["pdf", true],
      ["youtube", true],
      ["session", true],
    ]);
    expect(results[1]?.detail).toContain("blob deleted");
    // Session is attached to the PDF's document, and the secret never surfaces.
    expect(bodies["/api/realtime/session"]).toContain("pdf-doc");
    expect(JSON.stringify(results)).not.toContain(SECRET);
  });

  it("fails health when production is not on blob and upstash", async () => {
    const { deps } = fakeDeps({
      health: { ok: true, version: "1", uploadMode: "direct", state: "memory" },
    });
    const [health] = await runSmoke({ ...remote, session: false }, deps);
    expect(health?.ok).toBe(false);
    expect(health?.detail).toContain("uploadMode is direct");
  });

  it("fails the PDF step when the blob is still there after ingest", async () => {
    const { deps } = fakeDeps({ blobDeleted: false });
    const results = await runSmoke({ ...remote, session: false }, deps);
    expect(results.find((r) => r.name === "pdf")?.detail).toContain(
      "blob was not deleted",
    );
  });

  it("reports the error code of a refused YouTube ingest and keeps going", async () => {
    const { deps } = fakeDeps({ youtube: err(502, "youtube_blocked") });
    const results = await runSmoke(remote, deps);
    expect(results.find((r) => r.name === "youtube")?.detail).toBe(
      "status 502: youtube_blocked",
    );
    expect(results.find((r) => r.name === "session")?.ok).toBe(true);
  });

  it("does not mint a secret when the session step is off", async () => {
    const { deps, calls } = fakeDeps();
    await runSmoke({ ...remote, session: false }, deps);
    expect(calls).not.toContain("POST /api/realtime/session");
  });

  it("fails health on a real host that is still on in-memory state", async () => {
    const { deps } = fakeDeps({
      health: { ok: true, version: "1", uploadMode: "blob", state: "memory" },
    });
    const [health] = await runSmoke({ ...remote, session: false }, deps);
    expect(health?.detail).toContain("state is memory, want upstash");
  });

  it("uses multipart and accepts direct uploads on localhost", async () => {
    const { deps, calls } = fakeDeps({
      health: { ok: true, version: "1", uploadMode: "direct", state: "memory" },
    });
    const results = await runSmoke(
      { ...remote, baseUrl: "http://localhost:3000", session: false },
      deps,
    );
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.detail).toContain("multipart");
    expect(calls).not.toContain("POST /api/upload/token");
  });
});

describe("parseArgs", () => {
  it("defaults to the sample PDF and runs the session step", () => {
    expect(parseArgs(["https://a.example"], {})).toMatchObject({
      pdfPath: DEFAULT_PDF,
      session: true,
    });
  });
  it("reads the bypass secret from the environment only", () => {
    expect(
      parseArgs(["https://a.example"], { SMOKE_BYPASS_SECRET: " s " }),
    ).toMatchObject({ bypassSecret: "s" });
  });
  it("rejects plain http for a remote host and unknown flags", () => {
    expect(parseArgs(["http://a.example"], {})).toHaveProperty("error");
    expect(parseArgs(["https://a.example", "--wat"], {})).toHaveProperty(
      "error",
    );
    expect(parseArgs([], {})).toHaveProperty("error");
  });
});
