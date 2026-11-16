/**
 * Deploy smoke test:  pnpm smoke <base-url> [--no-session] [--pdf <file>] [--youtube <url>]
 *
 * Checks, in order, against a running app:
 *   1. /api/health reports the upload mode and state driver the host should
 *      have (blob + upstash on a real host; direct + memory or upstash on localhost)
 *   2. the sample PDF ingests through the configured upload mode (Blob client
 *      upload, or multipart) and streams NDJSON; in blob mode the blob must be
 *      gone afterwards (a second ingest answers upload_missing)
 *   3. one YouTube URL ingests
 *   4. one Realtime client secret is minted. WebRTC is never opened and the
 *      secret is never printed. THIS CALLS THE LIVE OPENAI API, so skip it with
 *      --no-session unless you mean it.
 *
 * SMOKE_BYPASS_SECRET (env, never an argument) is sent as the Vercel
 * protection-bypass header for protected preview URLs. Production is public.
 * Node runs this file directly, so keep to erasable TypeScript syntax.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PDF = "test/fixtures/pdf/multi-page.pdf";
// "Me at the zoo": 19 s, manual captions, never taken down. It is also the
// "Sample video" chip in the app, so the transcript is usually already in the
// 24 h cache and a smoke run does not spend a Supadata lookup. Keep the two in
// step (scripts/smoke.test.ts checks).
export const DEFAULT_YOUTUBE = "https://youtu.be/jNQXAC9IVRw";

export interface SmokeOptions {
  baseUrl: string;
  pdfPath: string;
  youtubeUrl: string;
  session: boolean;
  bypassSecret?: string;
}

export interface UploadArgs {
  pathname: string;
  body: Blob;
  handleUploadUrl: string;
}

export interface SmokeDeps {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<Uint8Array>;
  /** Browser-direct upload to Vercel Blob; returns the blob URL. */
  uploadToBlob: (args: UploadArgs) => Promise<{ url: string }>;
  now: () => number;
}

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface NdjsonResult {
  meta: Record<string, unknown> | undefined;
  units: number;
  done: Record<string, unknown> | undefined;
  error: Record<string, unknown> | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "code" of an error body, or a short fallback. Never the message text. */
async function errorCode(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => undefined);
  if (isRecord(body) && isRecord(body.error)) {
    const code = body.error.code;
    if (typeof code === "string") return code;
  }
  return "no error code";
}

export async function readNdjson(res: Response): Promise<NdjsonResult> {
  const out: NdjsonResult = {
    meta: undefined,
    units: 0,
    done: undefined,
    error: undefined,
  };
  if (!res.body) return out;
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  const take = (raw: string) => {
    if (raw.trim() === "") return;
    const line: unknown = JSON.parse(raw);
    if (!isRecord(line)) return;
    if ("documentId" in line) out.meta = line;
    else if ("page" in line || "segment" in line) out.units += 1;
    else if ("done" in line) out.done = line;
    else if ("error" in line) out.error = line;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
      take(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  }
  take(buffer);
  return out;
}

function isLocal(baseUrl: string): boolean {
  const { hostname } = new URL(baseUrl);
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

type Check = () => Promise<{ detail: string; documentId?: string }>;

export async function runSmoke(
  opts: SmokeOptions,
  deps: SmokeDeps,
): Promise<StepResult[]> {
  const base = opts.baseUrl.replace(/\/$/, "");
  const local = isLocal(base);
  const headers: Record<string, string> = {};
  if (opts.bypassSecret) {
    headers["x-vercel-protection-bypass"] = opts.bypassSecret;
  }
  const api = (path: string, init: RequestInit = {}) =>
    deps.fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    });
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const results: StepResult[] = [];
  const documents: string[] = [];
  const step = async (name: string, check: Check) => {
    const started = deps.now();
    try {
      const { detail, documentId } = await check();
      if (documentId) documents.push(documentId);
      results.push({
        name,
        ok: true,
        detail: `${detail} (${deps.now() - started} ms)`,
      });
    } catch (err) {
      results.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message : "failed",
      });
    }
  };

  await step("health", async () => {
    const res = await api("/api/health");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body: unknown = await res.json();
    if (!isRecord(body) || body.ok !== true) throw new Error("ok is not true");
    const wantUpload = local ? "direct" : "blob";
    if (body.uploadMode !== wantUpload) {
      throw new Error(
        `uploadMode is ${String(body.uploadMode)}, want ${wantUpload}`,
      );
    }
    // A dev machine may or may not have Upstash configured; a real host must.
    const states = local ? ["memory", "upstash"] : ["upstash"];
    if (typeof body.state !== "string" || !states.includes(body.state)) {
      throw new Error(
        `state is ${String(body.state)}, want ${states.join(" or ")}`,
      );
    }
    return {
      detail: `version ${String(body.version)}, upload ${wantUpload}, state ${body.state}`,
    };
  });

  await step("pdf", async () => {
    const bytes = await deps.readFile(opts.pdfPath);
    const fileName = basename(opts.pdfPath);
    let res: Response;
    let viaBlob: string | undefined;
    if (local) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes as BlobPart], { type: "application/pdf" }),
        fileName,
      );
      res = await api("/api/ingest/pdf", { method: "POST", body: form });
    } else {
      const query = opts.bypassSecret
        ? `?x-vercel-protection-bypass=${encodeURIComponent(opts.bypassSecret)}`
        : "";
      const blob = await deps.uploadToBlob({
        pathname: `uploads/smoke-${deps.now()}.pdf`,
        body: new Blob([bytes as BlobPart], { type: "application/pdf" }),
        handleUploadUrl: `${base}/api/upload/token${query}`,
      });
      viaBlob = blob.url;
      res = await api("/api/ingest/pdf", json({ blobUrl: blob.url, fileName }));
    }
    if (!res.ok)
      throw new Error(`status ${res.status}: ${await errorCode(res)}`);
    const nd = await readNdjson(res);
    if (nd.error) throw new Error("stream ended with an error line");
    if (!nd.meta || !nd.done || nd.units === 0) {
      throw new Error("stream was missing meta, pages or done");
    }
    let detail = `${nd.units} pages via ${local ? "multipart" : "blob"}`;
    if (viaBlob) {
      // The ingest route deletes the blob once it has the bytes.
      const again = await api(
        "/api/ingest/pdf",
        json({ blobUrl: viaBlob, fileName }),
      );
      const code = await errorCode(again);
      if (again.status !== 404 || code !== "upload_missing") {
        throw new Error(
          `blob was not deleted (second ingest: ${again.status} ${code})`,
        );
      }
      detail += ", blob deleted";
    }
    return { detail, documentId: String(nd.meta.documentId) };
  });

  await step("youtube", async () => {
    const res = await api(
      "/api/ingest/youtube",
      json({ url: opts.youtubeUrl }),
    );
    if (!res.ok)
      throw new Error(`status ${res.status}: ${await errorCode(res)}`);
    const nd = await readNdjson(res);
    if (nd.error) throw new Error("stream ended with an error line");
    if (!nd.meta || !nd.done || nd.units === 0) {
      throw new Error("stream was missing meta, paragraphs or done");
    }
    return {
      detail: `${nd.units} paragraphs via ${String(nd.meta.provider)}`,
      documentId: String(nd.meta.documentId),
    };
  });

  if (opts.session) {
    await step("session", async () => {
      const documentId = documents[0];
      if (!documentId) throw new Error("no ingested document to attach to");
      const res = await api("/api/realtime/session", json({ documentId }));
      if (!res.ok)
        throw new Error(`status ${res.status}: ${await errorCode(res)}`);
      const body: unknown = await res.json();
      if (
        !isRecord(body) ||
        typeof body.clientSecret !== "string" ||
        body.clientSecret === "" ||
        typeof body.model !== "string"
      ) {
        throw new Error("response had no client secret and model");
      }
      // Model and length only: the secret itself is a credential.
      return {
        detail: `secret minted, model ${body.model}, ${String(body.maxSessionSeconds)} s cap`,
      };
    });
  }

  return results;
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): SmokeOptions | { error: string } {
  let baseUrl: string | undefined;
  let pdfPath = DEFAULT_PDF;
  let youtubeUrl = DEFAULT_YOUTUBE;
  let session = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-session") session = false;
    else if (arg === "--pdf" || arg === "--youtube") {
      const value = argv[(i += 1)];
      if (!value) return { error: `${arg} needs a value` };
      if (arg === "--pdf") pdfPath = value;
      else youtubeUrl = value;
    } else if (arg?.startsWith("-")) return { error: `unknown option ${arg}` };
    else if (arg && !baseUrl) baseUrl = arg;
    else return { error: "only one URL is accepted" };
  }
  if (!baseUrl) return { error: "missing <base-url>" };
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !isLocal(baseUrl)) {
      return { error: "use https:// for anything that is not localhost" };
    }
  } catch {
    return { error: `not a URL: ${baseUrl}` };
  }
  return {
    baseUrl,
    pdfPath,
    youtubeUrl,
    session,
    bypassSecret: env.SMOKE_BYPASS_SECRET?.trim() || undefined,
  };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2), process.env);
  if ("error" in opts) {
    console.error(opts.error);
    console.error(
      "usage: pnpm smoke <base-url> [--no-session] [--pdf <file>] [--youtube <url>]",
    );
    return 2;
  }
  // Imported here so tests of the logic above never load the Blob SDK.
  const { upload } = await import("@vercel/blob/client");
  const results = await runSmoke(opts, {
    fetch,
    readFile,
    uploadToBlob: ({ pathname, body, handleUploadUrl }) =>
      upload(pathname, body, {
        access: "private",
        contentType: "application/pdf",
        handleUploadUrl,
      }),
    now: () => Date.now(),
  });
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
  }
  if (!opts.session) console.log("SKIP  session: --no-session");
  return results.every((r) => r.ok) ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
