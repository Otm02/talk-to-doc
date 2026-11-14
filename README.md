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

Open http://localhost:3000 (best at 390x844). `GET /api/health` shows the active model, upload mode and state backend.

## Scripts

| Script                         | Does                                        |
| ------------------------------ | ------------------------------------------- |
| `pnpm dev` / `build` / `start` | Next.js                                     |
| `pnpm check`                   | lint + typecheck + unit tests               |
| `pnpm test`                    | Vitest                                      |
| `pnpm test:e2e`                | Playwright at 390x844 (Chromium and WebKit) |
| `pnpm format`                  | Prettier                                    |
| `pnpm fixtures`                | Regenerate the test PDFs in `test/fixtures` |

Tests and CI never call the live OpenAI API, YouTube or Supadata. The YouTube tests serve responses recorded once by `scripts/record-youtube-fixtures.ts` (see `test/fixtures/README.md`).

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

## YouTube on the deployed app

**Why direct fetching fails from the cloud.** The app reads captions the way YouTube's own player does: the watch page, then the player API, then the caption file. That works from a home or office connection. YouTube blocks most cloud IP ranges (AWS, Google Cloud, Azure and so on, so Vercel too) with a captcha or a "confirm you're not a bot" answer, so the same code mostly fails once deployed.

**The provider chain.** `POST /api/ingest/youtube` tries providers in order:

1. **Direct**, our TypeScript port of the flow in [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) (MIT licensed). Free, no account.
2. **Supadata**, a hosted transcript API, only if `SUPADATA_API_KEY` is set.

The chain moves on only when the provider itself failed: blocked, timed out, or broke. If the video has no captions, is private, age-restricted or live, the answer would be the same from the next provider, so the chain stops and the user gets the reason (and no Supadata credit is spent).

**The fast-fail.** On Vercel, with Supadata configured, Direct gets 3 seconds for the whole attempt instead of 15, so a blocked IP costs the user 3 seconds, not 15. Without a fallback there is nothing to fail over to, so Direct keeps the long timeout. Locally Direct retries once after a network error; on Vercel it does not, and it never retries a block.

**Cost.** Supadata's free plan gives 100 credits a month, 1 request per second, and needs no credit card. We ask for existing captions only (`mode=native`), which is 1 credit per video, never the AI-generated transcript at 2 credits per minute. Transcripts are cached for an hour by video and language in the same store as the documents (memory locally, Upstash on Vercel), so pasting the same video again, or testing, spends nothing. The title and channel come from YouTube's public oEmbed endpoint, which costs no credit. If the credits run out, the user sees "We've used up our YouTube lookups for now" and PDFs keep working.

**Run fully local, with no third party.** Leave `SUPADATA_API_KEY` empty (or unset). The chain is then Direct only and nothing leaves your machine except requests to YouTube. If YouTube blocks your own IP, you will see "YouTube is blocking our server right now" and no fallback. To check which provider served a video, read `provider` in the first NDJSON line; the server log prints it too (ids and counts only, never transcript text).

## Docs

`docs/SPEC.md` (requirements), `docs/ARCHITECTURE.md`, `docs/PLAN.md` (milestones).
