# Talk to a Document or YouTube Video

[![CI](https://github.com/Otm02/talk-to-doc/actions/workflows/ci.yml/badge.svg)](https://github.com/Otm02/talk-to-doc/actions/workflows/ci.yml)

A mobile-first web app: upload a PDF or paste a YouTube link, read the extracted text, and talk about it live with the OpenAI Realtime API.

Status: PDF and YouTube pipelines (M2, M3). The server can ingest a PDF (direct upload locally, Vercel Blob when deployed) or a YouTube link and stream its text. The ingest UI and voice come in later milestones. See `docs/PLAN.md`.

## Setup

```bash
pnpm install
cp .env.example .env.local   # optional; defaults work without it
pnpm dev
```

Open http://localhost:3000 (best at 390x844). `GET /api/health` shows the version, upload mode and state backend.

## Scripts

| Script                         | Does                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| `pnpm dev` / `build` / `start` | Next.js                                                         |
| `pnpm check`                   | lint + typecheck + unit tests with the coverage gates           |
| `pnpm test`                    | Vitest                                                          |
| `pnpm test:e2e`                | Playwright at 390x844 (Chromium and WebKit), mock transport     |
| `pnpm test:live`               | The one test that calls the real API (see Testing). Never in CI |
| `pnpm format`                  | Prettier                                                        |
| `pnpm fixtures`                | Regenerate the test PDFs in `test/fixtures`                     |
| `pnpm icons`                   | Redraw the app icons (uses Playwright)                          |
| `pnpm smoke <url>`             | Deploy smoke test (see below)                                   |

Tests and CI never call the live OpenAI API, YouTube or Supadata (the one exception, `pnpm test:live`, is run by hand; see Testing). The YouTube tests serve responses recorded once by `scripts/record-youtube-fixtures.ts` (see `test/fixtures/README.md`).

### Try the PDF endpoint locally

```bash
pnpm dev
curl -N -F file=@some.pdf localhost:3000/api/ingest/pdf
```

It answers with newline-delimited JSON: a meta line, one line per page, then a `done` line with the totals. Refusals (too big, not a PDF, password, rate limit) come back as JSON with an HTTP status.

### Try the YouTube endpoint locally

```bash
pnpm dev
curl -N -X POST localhost:3000/api/ingest/youtube \
  -H 'content-type: application/json' \
  -d '{"url":"https://youtu.be/UF8uR6Z6KLc"}'
```

The first line is the meta (title, channel, language, whether the captions are auto-generated, and which provider served them), then one line per ~30 second paragraph, then `done`. Every URL shape works (watch, `youtu.be`, Shorts, embed, live, `m.`, `music.`, `youtube-nocookie`) and so does a bare 11-character id. A video without captions, a private one, a live stream or a playlist link comes back as JSON with an HTTP status and short copy.

## Testing

**Unit tests** (`pnpm test`, Vitest) run with coverage in `pnpm check`. Three gates fail the run: 80% for the whole app, and 90% for `src/server/**` and for the realtime core in `src/features/voice/realtime/**` (lines, statements, functions and branches each). Only framework glue is left out of the count: the Next `layout.tsx` and `page.tsx`, and the generated shadcn primitives in `src/components/ui`. CI prints the numbers per area in the job summary.

**End to end** (`pnpm test:e2e`, Playwright) walks the review script at 390x844 on Chromium and WebKit, against the mock transport, with the PDF route real and the YouTube route mocked. `docs/SPEC.md` section 2.6 lists every scenario and its test, and `scripts/spec-proofs.test.ts` fails if a file named anywhere in the SPEC is missing. Browsers come from `pnpm exec playwright install --with-deps chromium webkit`.

**CI** (`.github/workflows/ci.yml`) pins `runs-on: ubuntu-24.04`: `ubuntu-latest` moved to Ubuntu 26, where `playwright install --with-deps` fails. Jobs: a secret scan, `check` (lint, `next typegen` then `tsc`, unit tests with coverage, build, bundle scan) and `e2e` once per browser, with the Playwright browsers cached and the HTML report uploaded when a run fails. WebKit runs in CI as its own job, `e2e (webkit)`. This has not been seen passing on a GitHub runner yet; if its system packages fail to install there, remove `webkit` from the matrix and treat WebKit as local-only (`pnpm exec playwright test --project=webkit`).

**The live test** (`e2e/live.spec.ts`, tagged `@live`) is the only test that reaches OpenAI. Chromium plays `test/fixtures/audio/question.wav` (or the file `LIVE_QUESTION_WAV` names) into a fake microphone, the real app starts a real chat, and the test asserts that an assistant transcript appears; it then ends the chat. It refuses to run on anything but `gpt-realtime-2.1-mini` (it reads `REALTIME_MODEL`, default mini), checks the model the server actually minted, and has no retries. It needs `OPENAI_API_KEY` in the environment the server reads and a recording of a spoken question: the committed `question.wav` is synthetic, speech-shaped but silent of words, so nobody's voice is in the repo. Record yourself asking something about `multi-page.pdf` (16 kHz mono 16-bit PCM WAV) and run `LIVE_QUESTION_WAV=path/to/it.wav pnpm test:live`. Run it by hand with `pnpm test:live`: a few cents each time, twice at most. `pnpm test:e2e` excludes it and it skips itself when `CI` is set. It builds the app with the real transport into `.next`, so the next `pnpm test:e2e` rebuilds.

## YouTube on the deployed app

**Why direct fetching fails from the cloud.** The app reads captions the way YouTube's own player does: the watch page, then the player API, then the caption file. That works from a home or office connection. YouTube blocks most cloud IP ranges (AWS, Google Cloud, Azure and so on, so Vercel too) with a captcha or a "confirm you're not a bot" answer, so the same code mostly fails once deployed.

**The provider chain.** `POST /api/ingest/youtube` tries providers in order:

1. **Direct**, our TypeScript port of the flow in [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) (MIT licensed). Free, no account.
2. **Supadata**, a hosted transcript API, only if `SUPADATA_API_KEY` is set.

The chain moves on only when the provider itself failed: blocked, timed out, or broke. If the video has no captions, is private, age-restricted or live, the answer would be the same from the next provider, so the chain stops and the user gets the reason (and no Supadata credit is spent).

**The fast-fail.** On Vercel, with Supadata configured, Direct gets 3 seconds for the whole attempt instead of 15, so a blocked IP costs the user 3 seconds, not 15. Without a fallback there is nothing to fail over to, so Direct keeps the long timeout. Locally Direct retries once after a network error; on Vercel it does not, and it never retries a block.

**Cost.** Supadata's free plan gives 100 credits a month, 1 request per second, and needs no credit card. We ask for existing captions only (`mode=native`), which is 1 credit per video, never the AI-generated transcript at 2 credits per minute. Transcripts are cached for an hour by video and language in the same store as the documents (memory locally, Upstash on Vercel), so pasting the same video again, or testing, spends nothing. The title and channel come from YouTube's public oEmbed endpoint, which costs no credit. If the credits run out, the user sees "We've used up our YouTube lookups for now" and PDFs keep working.

**Run fully local, with no third party.** Leave `SUPADATA_API_KEY` empty (or unset). The chain is then Direct only and nothing leaves your machine except requests to YouTube. If YouTube blocks your own IP, you will see "YouTube is blocking our server right now" and no fallback. To check which provider served a video, read `provider` in the first NDJSON line; the server log prints it too (ids and counts only, never transcript text).

## Deploying and smoke test

Environment variables per environment, the production switch and the dashboard steps are in `docs/DEPLOY.md`.

```bash
pnpm smoke https://your-app.vercel.app --no-session
pnpm smoke https://your-app.vercel.app            # also mints one client secret
```

It runs four checks and exits non-zero if any fails:

1. `/api/health` reports `uploadMode: "blob"` and `state: "upstash"` (on localhost: `direct`, and `memory` or `upstash`).
2. The sample PDF (`test/fixtures/pdf/multi-page.pdf`, or `--pdf <file>`) goes through the configured upload mode and streams back as NDJSON. In blob mode it then checks the blob was deleted.
3. One YouTube URL ingests (`--youtube <url>` to change it).
4. One Realtime client secret is requested for the ingested document. WebRTC is never opened and the secret is never printed. **This is a live OpenAI call**; `--no-session` skips it.

For a preview behind Vercel Authentication, set `SMOKE_BYPASS_SECRET` in the environment (not on the command line).

## Docs

`docs/SPEC.md` (requirements), `docs/ARCHITECTURE.md`, `docs/PLAN.md` (milestones).
