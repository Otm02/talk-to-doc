/**
 * Manual check of the Blob path on a deployed preview (acceptance MC-1).
 *
 *   node scripts/blob-smoke.ts <base-url> <pdf> [protection-bypass-secret]
 *
 * It does what the browser will do in M4: asks /api/upload/token for a
 * client token, uploads the PDF straight to Vercel Blob, then calls
 * /api/ingest/pdf with the blob URL and reads the NDJSON. Finally it calls
 * ingest again with the same URL: the blob must be gone, so that has to
 * answer upload_missing. Also look at the Blob dashboard afterwards.
 *
 * The bypass secret is only for previews behind Vercel Authentication.
 */
import { upload } from "@vercel/blob/client";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const [baseUrl, pdfPath, bypass] = process.argv.slice(2);
if (!baseUrl || !pdfPath) {
  console.error(
    "usage: node scripts/blob-smoke.ts <base-url> <pdf> [bypass-secret]",
  );
  process.exit(2);
}

const base = baseUrl.replace(/\/$/, "");
const fileName = basename(pdfPath);
const headers: Record<string, string> = { "content-type": "application/json" };
if (bypass) headers["x-vercel-protection-bypass"] = bypass;

const bytes = await readFile(pdfPath);
console.log(
  `uploading ${fileName} (${(bytes.length / 1e6).toFixed(1)} MB) to Blob...`,
);
const t0 = performance.now();
const blob = await upload(
  `uploads/smoke-${Date.now()}.pdf`,
  new Blob([bytes], { type: "application/pdf" }),
  {
    access: "private",
    contentType: "application/pdf",
    // The query form of the bypass works for the SDK's token request.
    handleUploadUrl: `${base}/api/upload/token${bypass ? `?x-vercel-protection-bypass=${encodeURIComponent(bypass)}` : ""}`,
  },
);
console.log(`uploaded in ${Math.round(performance.now() - t0)} ms`);

async function ingest(): Promise<Response> {
  return fetch(`${base}/api/ingest/pdf`, {
    method: "POST",
    headers,
    body: JSON.stringify({ blobUrl: blob.url, fileName }),
  });
}

const t1 = performance.now();
const res = await ingest();
console.log("ingest status", res.status);
if (!res.ok || !res.body) {
  console.log(await res.text());
  process.exit(1);
}

let pages = 0;
let firstPageMs: number | undefined;
let done: unknown;
let failure: unknown;
const decoder = new TextDecoder();
let buffer = "";
const reader = res.body.getReader();
for (;;) {
  const { done: finished, value } = await reader.read();
  if (finished) break;
  buffer += decoder.decode(value, { stream: true });
  for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
    const line: unknown = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (typeof line !== "object" || line === null) continue;
    if ("page" in line) {
      pages += 1;
      firstPageMs ??= Math.round(performance.now() - t1);
    } else if ("done" in line) done = line;
    else if ("error" in line) failure = line;
  }
}
console.log(
  `pages streamed: ${pages}, first page after ${firstPageMs} ms, total ${Math.round(performance.now() - t1)} ms`,
);
console.log("done line:", JSON.stringify(done));
if (failure) console.log("error line:", JSON.stringify(failure));

const again = await ingest();
const body: unknown = await again.json().catch(() => undefined);
const gone =
  again.status === 404 &&
  typeof body === "object" &&
  body !== null &&
  "error" in body &&
  JSON.stringify(body.error).includes("upload_missing");
console.log(
  gone
    ? "PASS: the blob is gone (second ingest answered upload_missing)"
    : `FAIL: second ingest answered ${again.status}`,
);
process.exit(done && gone ? 0 : 1);
