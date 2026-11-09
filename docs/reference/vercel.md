# Vercel (Hobby), Blob, Upstash Redis, deployment protection

Researched 2026-11-09 from the official Vercel and Upstash docs, plus the `@vercel/blob@2.8.2`, `@upstash/redis@1.41.0` and `@upstash/ratelimit@2.2.0` package sources where the docs were silent. Items marked **UNVERIFIED** were not confirmed anywhere.

## 1. Hobby limits that affect us

Source: https://vercel.com/docs/functions/limitations (last updated 2026-08-24)

| Limit | Hobby value |
|---|---|
| Request body to a Function | **4.5 MB** (413 `FUNCTION_PAYLOAD_TOO_LARGE` above it) |
| Response body from a Function | **4.5 MB, but the limit does not apply to streamed responses** |
| Max duration | **300 s** default and maximum (Fluid compute). Streaming time counts toward it. Over the limit: 504 `FUNCTION_INVOCATION_TIMEOUT` |
| Memory | 2 GB / 1 vCPU (default and maximum) |
| Bundle size | 250 MB uncompressed |
| Concurrency | auto-scales to 30,000 |
| File descriptors | 1,024 shared (close connections) |
| Runtime | Node.js on Fluid compute is the default. Edge runtime is deprecated; stay on Node as CLAUDE.md says |

Consequences:
- A PDF can never pass through a Function body (25 MB > 4.5 MB). Browser to Blob directly, then the route reads it from Blob.
- NDJSON streaming (`Response` with a `ReadableStream`, `Content-Type: application/x-ndjson`) is allowed past 4.5 MB. Extraction of a big PDF must finish inside 300 s including the stream.
- Set `export const maxDuration = 300;` on the ingest route handlers explicitly. Set `export const runtime = "nodejs";`. **Do not export `dynamic`:** this app enables `cacheComponents`, and Next 16 says to remove `dynamic = "force-dynamic"` under Cache Components (`node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md`, section "dynamic = force-dynamic"). Request-reading handlers already run at request time.
- Per-function cold start and `unpdf` size are fine against 250 MB.
- Active CPU pricing does not matter on Hobby (free within limits) but Hobby has overall usage caps; see https://vercel.com/docs/limits.

## 2. Vercel Blob client uploads

Sources: https://vercel.com/docs/vercel-blob/client-upload , https://vercel.com/docs/vercel-blob/using-blob-sdk , https://vercel.com/docs/vercel-blob/private-storage , https://vercel.com/docs/vercel-blob/usage-and-pricing

Install: `pnpm add @vercel/blob` (needed only for `UPLOAD_MODE=blob`; justify in the PR: browser-direct upload past the 4.5 MB body cap).

Store and env:
- Create the store with `vercel blob create-store <name> --access private --yes` or in the dashboard (Storage tab). `--access` is **required**: `private` or `public`.
- Connecting a store adds `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` (server-side OIDC access).
- **`handleUpload` needs the long-lived `BLOB_READ_WRITE_TOKEN`**, which the dashboard adds only if you tick "Add a read-write token env var to this connection". OIDC alone is not enough for `handleUpload` (`handleUploadPresigned` is the OIDC-friendly variant; not evaluated here). Add it to the env schema in `src/server/env.ts`, server-only.
- Pull to local with `vercel env pull` (the store connection must include the Development environment).

Browser side (`'use client'`):
```ts
import { upload } from "@vercel/blob/client";

const blob = await upload(file.name, file, {
  access: "private",                 // required; must match the store
  handleUploadUrl: "/api/upload",    // our token route
  clientPayload: JSON.stringify({ size: file.size }), // optional string, arrives in onBeforeGenerateToken
  onUploadProgress: ({ loaded, total, percentage }) => { /* progress UI */ },
  abortSignal: controller.signal,    // for a Cancel button
});
// blob.url, blob.pathname, blob.contentType, blob.downloadUrl
```
Do NOT pass `multipart: true` for our sizes. Multipart counts one advanced operation per part plus start and complete; docs recommend it for files over 100 MB.

Token route (`app/api/upload/route.ts`, Node runtime, thin):
```ts
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody; // validate with zod in real code
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // 1. rate-limit by IP here, 2. reject anything unexpected
        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true,
          validUntil: Date.now() + 5 * 60_000,   // default is now + 1 h
          tokenPayload: JSON.stringify({ /* anything the completion hook needs */ }),
        };
      },
      onUploadCompleted: async () => { /* optional; see below */ },
    });
    return Response.json(json);
  } catch {
    // docs: Blob does not retry the webhook on 400; it retries 5x on 429/500/502/503/504
    return Response.json({ error: { code: "upload_rejected", message: "Upload not allowed." } }, { status: 400 });
  }
}
```
Option facts: `addRandomSuffix` default `false` (docs recommend `true`); `allowedContentTypes` default all, wildcards allowed; `maximumSizeInBytes` max 5 TB, no default; `validUntil` ms timestamp, default now + 1 h; `allowOverwrite` default false (overwrite throws); `cacheControlMaxAge` default 1 month, min 60 s; `callbackUrl`, `tokenPayload`, `ifMatch` optional.

Security notes:
- **The docs say you must authenticate in `onBeforeGenerateToken`; we have no user accounts.** Compensate with the RateLimiter adapter (per IP), the content-type and size caps above, and a short `validUntil`.
- `allowedContentTypes` and `maximumSizeInBytes` are enforced by Blob from what the client sends. After upload, **verify the `%PDF-` magic bytes and the real size server-side** before extracting, and delete the blob if it fails.
- `onUploadCompleted` is called by Vercel's servers over HTTP. It **cannot reach localhost** (needs ngrok and `VERCEL_BLOB_CALLBACK_URL`). Do not depend on it. Instead have the browser call our ingest route with the returned `blob.pathname` after `upload()` resolves. The callback URL is computed from `VERCEL_BRANCH_URL` / `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL`; on protected previews it will also be blocked by deployment protection.

Reading a private blob on the server (the browser cannot read private URLs):
```ts
import { get } from "@vercel/blob";
const res = await get(pathname, { access: "private" });   // null if missing
if (res?.statusCode !== 200) throw new AppError("upload_missing");
const bytes = new Uint8Array(await new Response(res.stream).arrayBuffer());
```
`get` options: `access` (required), `useCache` (default true; reads after an overwrite can be stale up to 60 s, so with unique suffixed paths this is moot), `ifNoneMatch`, `headers`, `abortSignal`. Private URL form: `https://<store-id>.private.blob.vercel-storage.com/<pathname>`; public: `*.public.blob.vercel-storage.com`. Needs `@vercel/blob` >= 2.3 for private.

Delete after ingest (we do not need to keep PDFs):
```ts
import { del } from "@vercel/blob";
await del(blob.url);          // or del([a, b]); accepts url or pathname; does not throw if already gone
```
Deletes are free operations, but each blob in a batch counts toward the rate limit. CDN may serve the old blob for up to ~1 min (irrelevant for private + never re-read).

**CSP hosts.** The docs do not name the upload endpoint. From `@vercel/blob@2.8.2` dist, the default API base is **`https://vercel.com/api/blob`** (env override `VERCEL_BLOB_API_URL`). So the browser needs `connect-src https://vercel.com` for the upload PUT (plus `'self'` for the token route). The SDK may also hit `*.blob.vercel-storage.com`; **UNVERIFIED**, so confirm the exact hosts from the Network panel on the first real upload and tighten the CSP to those. Reads of private blobs happen server-side only, so no `img-src`/`connect-src` is needed for `*.private.blob.vercel-storage.com`.

Hobby Blob quotas (included, free): **1 GB storage, 10,000 simple ops, 2,000 advanced ops, 10 GB transfer per month.** Uploads, copy, list and creating a store are advanced ops (1 per upload when not multipart). Rate limit on Hobby: 15 advanced ops/s, 20 simple ops/s. **Exceeding a Hobby quota does not bill, it locks Blob for up to 30 days.** That would take the demo down, so: delete blobs right after ingest, cap uploads per IP and globally via the RateLimiter, and watch usage in the dashboard (Observability > Blob).
Client uploads incur no data-transfer charge. Max file size is 5 TB, so our 25 MB cap is ours to enforce.

## 3. Upstash Redis on Vercel

Sources: https://upstash.com/pricing/redis , https://upstash.com/docs/redis/sdks/ratelimit-ts/overview , https://vercel.com/marketplace/upstash/upstash-kv , package sources.

Provision: Vercel dashboard > Storage / Marketplace > Upstash > Redis > Free plan (or `vercel integration add upstash`; use the marketplace skill). Free needs no card (a card only upgrades to pay-as-you-go; the pricing FAQ implies this, not stated outright for sign-up).

Env vars injected on Vercel: the integration keeps the legacy Vercel KV names, **`KV_REST_API_URL`**, **`KV_REST_API_TOKEN`** (also `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL`). Sources disagree (some guides say `UPSTASH_REDIS_REST_*`), so **run `vercel env pull` after install and read the real names**. `Redis.fromEnv()` (verified in `@upstash/redis@1.41.0` source) reads `UPSTASH_REDIS_REST_URL` falling back to `KV_REST_API_URL`, and `UPSTASH_REDIS_REST_TOKEN` falling back to `KV_REST_API_TOKEN`.
Per CLAUDE.md, only `src/server/env.ts` reads secrets. Do not call `Redis.fromEnv()` from other modules: read both name pairs in env.ts, validate with zod, and pass `{ url, token }` to `new Redis(...)`.

```ts
import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

const redis = new Redis({ url: env.UPSTASH_URL, token: env.UPSTASH_TOKEN });

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),   // also fixedWindow(n, "1 m"), tokenBucket(refill, "10 s", max)
  prefix: "ttd:rl:ingest",
  analytics: false,        // saves commands; avoids the `pending` promise
  timeout: 2000,           // ms. On timeout the request is ALLOWED (fail-open)
});

const { success, limit, remaining, reset, reason } = await ratelimit.limit(ip);
// reset = epoch ms. reason is "timeout" | "cacheBlock" | "denyList" when set.
if (!success) { /* 429 with Retry-After from reset */ }
```
- `limit()` returns `{ success, limit, remaining, reset, pending, reason? }`. On serverless, `pending` (analytics/multi-region work) must be awaited via `waitUntil` or it can be cut off; with `analytics: false` there is nothing to wait for.
- **Fail-open on timeout** means an Upstash outage disables limiting. For the endpoints that spend OpenAI money (client secret minting), treat `reason === "timeout"` as a denial.
- Versions: `@upstash/ratelimit@2.2.0` needs peer `@upstash/redis ^1.38.2`. Both are HTTP-based, no connection pooling, fine for serverless.
- `reason: "cacheBlock"` means an in-process `ephemeralCache` (a module-level `Map`, on by default) rejected the call without touching Redis. It only short-circuits identifiers Redis already blocked, so it is a safe optimization, not shared state. Pass `ephemeralCache: false` if you want every decision to come from Redis (simpler to test).
- Ratelimit keys are namespaced by `prefix` (default `@upstash/ratelimit`). Use distinct prefixes for each limiter.
- Exact commands per `limit()` call are not documented (**UNVERIFIED**; sliding window uses a multi-command Lua script). Budget conservatively.

Free plan limits: **500K commands/month, 250 MB data, 10 GB bandwidth/month, 10,000 commands/s, 10 MB max request size, 100 MB max record size, 1 database.**
Design impacts:
- Document text can be several MB. Store it page by page (matches the NDJSON page lines) under one prefix with a TTL (e.g. 1 to 2 h), not as one 25 MB value. A 10 MB request cap and a 250 MB total make a single big key a bad idea.
- Every read/write of a page is a command. For the 500K/month budget, prefer `MGET`/pipelines and a single metadata key.
- Give every key a TTL so the 250 MB cap cannot fill up.
- Usage ledger writes: one `INCRBYFLOAT`/`HINCRBY` per `response.done`, not one list entry.

## 4. Preview deployment protection

Sources: https://vercel.com/docs/deployment-protection , https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication , https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation

- Methods on Hobby: **Vercel Authentication** (all plans). Password Protection is **not available on Hobby** (Pro, $20/project/month). Trusted IPs and Passport are Enterprise.
- Scope **Standard Protection** (available on all plans): protects every deployment URL **except production domains**. So preview URLs and generated `*.vercel.app` deployment URLs need a Vercel login; the production domain stays public. Other scopes: All Deployments (also protects production), Legacy Standard, Legacy Pre-Production. Configure in Settings > Deployment Protection, or the API field `ssoProtection.deploymentType` (`all_except_custom_domains`, `all`, `preview`, `prod_deployment_urls_and_all_previews`; `null` disables). Whether a brand-new project defaults to Standard Protection is **UNVERIFIED**; check the dashboard.
- Who gets in: team members, project members, access-group members, users explicitly granted access, anyone with a **Shareable Link**, and requests carrying the automation bypass. **A Hobby account can have only one external user granted access**, so do not rely on access grants for the reviewer.
- **Implication for the reviewer (Genius):** give them the production URL (public under Standard Protection) or a Shareable Link for a specific preview. Do not hand out preview URLs expecting them to open. Previews also break `onUploadCompleted` callbacks and server-to-self fetches (use relative/same-origin URLs).
- Bypass for automation (all plans): create a secret in Settings > Deployment Protection. Vercel exposes it to deployments as `VERCEL_AUTOMATION_BYPASS_SECRET`. Send it as header `x-vercel-protection-bypass: <secret>` (preferred) or query `?x-vercel-protection-bypass=<secret>`. Add `x-vercel-set-bypass-cookie: true` to set a cookie for follow-up browser requests (`samesitenone` inside iframes). Playwright:
  ```ts
  use: { extraHTTPHeaders: {
    "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET!,
    "x-vercel-set-bypass-cookie": "true",
  } }
  ```
  Our rule says CI never calls the live OpenAI API, so e2e runs against `pnpm start` with mocks, not against Vercel previews. Only a manual smoke test of a deployed preview needs this. The bypass does not override active DDoS mitigations.
- Never print the bypass secret or `BLOB_READ_WRITE_TOKEN`; both are secrets (CLAUDE.md: read env only in `src/server/env.ts`).
