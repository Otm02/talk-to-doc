# Deploying to Vercel (M11)

Everything here is free-plan only (Vercel Hobby, Vercel Blob, Upstash free). Facts about limits live in `docs/reference/vercel.md`.

## 1. Route audit

| Route | Runtime | `maxDuration` | Request body | Response |
|---|---|---|---|---|
| `GET /api/health` | Node | 10 s | none | tiny JSON |
| `POST /api/upload/token` | Node | 15 s | JSON, capped at 8 KB in code | tiny JSON |
| `POST /api/ingest/pdf` | Node | 60 s (pipeline stops itself at 55 s) | blob mode: JSON, capped at 8 KB. `direct` (multipart) is refused on Vercel by `env.ts` | NDJSON stream, exempt from the 4.5 MB response cap |
| `POST /api/ingest/youtube` | Node | 60 s (worst case 3 + 15 + 30 s) | JSON, capped at 8 KB | NDJSON stream |
| `POST /api/realtime/session` | Node | 20 s | JSON, capped at 512 KB: a first start sends a few bytes (the document text is fetched server-side, never sent by the browser), but a reconnect carries up to 30 finished turns of up to 4,000 characters each as history | small JSON |
| `GET /api/cron/cleanup` | Node | 30 s | none | `{ deleted }` |

- **Runtime.** No route exports `runtime`: with `cacheComponents` it is a build error, and Node on Fluid compute is the default (reference §1).
- **4.5 MB.** The only large body is the PDF, and in blob mode it goes browser to Blob. No route accepts more than 8 KB of JSON except `POST /api/realtime/session`, which takes up to 512 KB for a reconnect's history. Responses that can be large are streamed.
- **3 s YouTube fast-fail.** `buildProviders` uses 3 s for Direct only when `onVercel` (Vercel sets `VERCEL` itself, in every environment) **and** `SUPADATA_API_KEY` is set in that environment. Without the key, Direct keeps 15 s. So the key must exist in Production (and Preview). Unit-tested in `chain.test.ts`; confirm live by checking that `pnpm smoke` reports `provider supadata` for the YouTube step (Direct is normally blocked from Vercel).
- **`vercel.json`** stays, with two entries that cannot live anywhere else: `buildCommand` (`pnpm build && pnpm check:bundle`, so a leaked secret fails the deploy) and the daily cleanup cron (Hobby allows once a day). No `regions` (Hobby has one function region; the default `iad1` is next to OpenAI) and no per-function config (`maxDuration` lives next to each handler).

## 2. Environment variables

Set in Vercel > Project > Settings > Environment Variables. Tick **Sensitive** on every secret (S). Names come from `src/server/env.ts`. Unlisted variables keep their defaults.

| Variable | S | Development | Preview | Production (until the final switch) |
|---|---|---|---|---|
| `OPENAI_API_KEY` | S | leave unset (use `.env.local`) | the key | the key |
| `REALTIME_MODEL` | | unset | `gpt-realtime-2.1-mini` | `gpt-realtime-2.1-mini` |
| `CONTEXT_TOKEN_BUDGET` | | unset (8000) | `8000` | `8000` |
| `MAX_SESSION_MINUTES` | | unset (5) | `3` | `5` |
| `DAILY_SESSION_CAP` | | unset (40) | unset (40); set `3` while tripping the guard by hand (MC-8) | `15` |
| `VOICE_ENABLED` | | unset | `true` | `true` |
| `UPLOAD_MODE` | | unset (`direct`) | `blob` | `blob` |
| `BLOB_READ_WRITE_TOKEN` | S | from the store connection, optional | from the store connection | from the store connection |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | S | from the integration, optional | from the integration | from the integration |
| `IP_HASH_SALT` | S | unset (random per run) | 16+ random chars | a different 16+ random chars |
| `CRON_SECRET` | S | unset | not needed (Vercel runs crons on Production only) | 16+ random chars |
| `SUPADATA_API_KEY` | S | optional | the key | the key |

Generate a salt or cron secret: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

**Final production switch (Production only, then redeploy).** Production starts on the safe values in the table above (the cheap model, 8,000 tokens of document, 15 session starts a day). For the final QA, the video and the review, set these four. The cap stays at 15 and the length stays at 5 minutes on purpose: 15 full chats on 2.1 are about $7 at the very worst (SPEC section 7.4), and the key's $20 limit has to cover the review as well.

| Variable | Until the switch | Final production |
|---|---|---|
| `REALTIME_MODEL` | `gpt-realtime-2.1-mini` | `gpt-realtime-2.1` |
| `CONTEXT_TOKEN_BUDGET` | `8000` | `20000` |
| `MAX_SESSION_MINUTES` | `5` | `5` |
| `DAILY_SESSION_CAP` | `15` | `15` |

Dev and preview keep the code defaults (mini, 8000, 5 minutes, 40 a day).

Env changes apply only to **new** deployments: after editing, Deployments > latest production > ⋯ > **Redeploy** (untick "use existing build cache" is not needed). Run `pnpm smoke <prod-url> --no-session` afterwards, then once without `--no-session` after asking.

**State namespace.** The free Upstash plan has one database, shared by every environment. Keys are prefixed by `VERCEL_ENV`: Production uses `ttd`, Preview `ttd-preview`, local `ttd-local`, so testing a preview can never use up Production's `DAILY_SESSION_CAP`.

## 3. Dashboard steps (what only you can click)

1. **Storage > Blob**: create a **private** store, connect it to the project for Production **and** Preview, and tick "Add a read-write token env var" (`handleUpload` needs `BLOB_READ_WRITE_TOKEN`).
2. **Storage > Marketplace > Upstash > Redis**, Free plan, connect to the project for Production and Preview. Open Settings > Environment Variables and confirm which names were added (`KV_REST_API_*` or `UPSTASH_REDIS_REST_*`); both work.
3. **Settings > Environment Variables**: add the rows above. Production and Preview are separate checkboxes on each variable.
4. **Settings > Deployment Protection**: Vercel Authentication on, scope **Standard Protection** (previews need a login, production stays public). Create an automation bypass secret only if you want `SMOKE_BYPASS_SECRET` for previews.
5. **Settings > Functions**: Node.js version 22 or 24, region `iad1` (Washington DC).
6. **Settings > Cron Jobs**: after the first production deploy, confirm `/api/cron/cleanup` is listed.
7. Deploy production (merge to `main`, or Redeploy).

## 4. Smoke test

```bash
pnpm smoke https://<production-url> --no-session   # no OpenAI call
pnpm smoke https://<production-url>                 # also mints ONE client secret (live OpenAI call; ask first)
```

See the README for what it checks. After it, look at **Storage > Blob**: zero stored blobs.

## 5. By hand once (a script cannot see these)

- Upload a real PDF from a phone or a browser with DevTools open. Check the Console and Network for **CSP violations** on the upload. `src/lib/security-headers.ts` allows `*.public.blob.vercel-storage.com` and `https://vercel.com`, but the store is **private**: if the PUT is blocked, add the host the Network panel shows (probably `*.private.blob.vercel-storage.com`) to `connect-src`.
- Production health: `curl https://<production-url>/api/health` must show `"uploadMode":"blob","state":"upstash"`.
- Response headers and bundle: nothing secret (`pnpm check:bundle` runs in the build).
