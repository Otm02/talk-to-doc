# Talk to a Document or YouTube Video

[![CI](https://github.com/Otm02/talk-to-doc/actions/workflows/ci.yml/badge.svg)](https://github.com/Otm02/talk-to-doc/actions/workflows/ci.yml)

A mobile-first web app: upload a PDF or paste a YouTube link, read the extracted text, and talk about it live with the OpenAI Realtime API.

Status: PDF pipeline (M2). The server can ingest a PDF (direct upload locally, Vercel Blob when deployed) and stream its text. The ingest UI, YouTube and voice come in later milestones. See `docs/PLAN.md`.

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

Tests and CI never call the live OpenAI API.

### Try the PDF endpoint locally

```bash
pnpm dev
curl -N -F file=@some.pdf localhost:3000/api/ingest/pdf
```

It answers with newline-delimited JSON: a meta line, one line per page, then a `done` line with the totals. Refusals (too big, not a PDF, password, rate limit) come back as JSON with an HTTP status.

## Docs

`docs/SPEC.md` (requirements), `docs/ARCHITECTURE.md`, `docs/PLAN.md` (milestones).
