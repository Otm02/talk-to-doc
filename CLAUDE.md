# Talk to a Document or YouTube Video

## Product
Mobile-first web app, designed at 390x844. A user uploads a PDF (25 MB max) or pastes a YouTube URL. The server extracts the text, the app shows the full text in a collapsible preview, and the user holds a live voice conversation about it through the OpenAI Realtime API over WebRTC. Text chat is the fallback when no microphone is available.

Sources of truth: docs/SPEC.md (requirements and acceptance tests), docs/PLAN.md (milestones), docs/reference/*.md (external API and platform facts). The brief is in .private/brief.md and must never be committed or quoted in public files.

## Stack
Next.js 16 App Router with Node runtime route handlers, React, TypeScript strict, Tailwind v4, shadcn/ui, lucide-react, zod, unpdf, gpt-tokenizer, Vitest with Testing Library, Playwright, pnpm. Hosting: Vercel Hobby (free), with Vercel Blob for PDF uploads and Upstash Redis (free plan) for shared state. Nothing may require a paid plan or a credit card.

## Budget rules
The OpenAI key belongs to Genius and is capped at $20 for everything, including their review.
- REALTIME_MODEL defaults to gpt-realtime-2.1-mini. Only production switches to gpt-realtime-2.1, at the end.
- Unit tests, e2e tests and CI never call the live OpenAI API. Use MockTransport and recorded fixtures.
- Ask me before any step that calls the live API, and keep live sessions short.
- Every response.done usage block is priced and recorded in the UsageLedger.

## Commands
- pnpm dev, pnpm build, pnpm start
- pnpm check: lint + typecheck + unit tests. Must pass before you report any task done.
- pnpm test, pnpm test:e2e, pnpm format

## Architecture rules
- src/server/** is server-only (import "server-only"). Client code never imports it.
- Secrets are read only in src/server/env.ts, validated with zod. Never prefix a secret with NEXT_PUBLIC_. The browser only ever receives a short-lived Realtime client secret.
- Route handlers stay thin: validate input with zod, call one service in src/server, map AppError to { error: { code, message } }.
- Shared state goes through three adapters: DocumentStore, RateLimiter, UsageLedger. In-memory locally and in tests, Upstash on Vercel, chosen by env. Never rely on module-level memory in production.
- PDFs never pass through a Vercel Function body (4.5 MB cap). UPLOAD_MODE=blob uploads from the browser to Vercel Blob; UPLOAD_MODE=direct (local and CI) posts multipart to the route.
- Ingest routes stream NDJSON (a metadata line, then page lines), so large documents never hit the 4.5 MB response cap.
- Every external call (OpenAI, YouTube, Supadata, Blob, Upstash) goes through an adapter with a timeout and typed errors. Never leak upstream messages or stack traces to the client.
- No middleware or proxy.ts. Next buffers proxied request bodies at 10 MB and would truncate local 25 MB uploads. Security headers live in next.config; rate limiting lives in the handlers.
- Realtime client code lives in src/features/voice/realtime: a transport interface (WebRTC and mock), zod-typed server events, a pure reducer, one hook. Components render state and hold no protocol logic.
- Realtime API shapes come from docs/reference/openai-realtime.md or the openaiDeveloperDocs MCP, never from memory. GA names only, no beta events.
- Document text reaches the model only through server-built session instructions, fenced and labeled as untrusted reference material.

## Mobile UX rules
Design at 390x844 first. Tap targets at least 44 px. Use dvh units and safe-area insets. Every async action has visible idle, working, success and error-with-retry states. Respect prefers-reduced-motion. Check UI work with the playwright MCP before reporting it done.

## Code style
No any, no ts-ignore, no non-null assertions on external data. Discriminated unions with exhaustive switches. Small modules, named exports, tests next to the code (*.test.ts). Comments explain why, not what. User-facing copy is short and plain.

## Definition of done
1. pnpm check passes, and pnpm test:e2e passes if UI changed.
2. New behavior has tests, including every edge case the task names.
3. UI changes were checked at 390x844 with the playwright MCP and you looked at the screenshots.
4. Your report says what changed, how you verified it (commands and results), what I should test by hand, and a conventional commit message.
5. Never claim something works that you did not run. After 3 failed attempts at the same problem, stop and report what you tried.

## Never
Read or print .env files or the API key. Add a dependency without one line of justification, or one that needs a paid plan. Commit .private/. Chunk, summarize or add citations to documents (out of scope); the only reduction allowed is the token-budget cap in src/server/context.
