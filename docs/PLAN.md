# PLAN

Status: v1, 2026-11-09. Requirements and IDs come from [SPEC.md](SPEC.md); modules and decisions from [ARCHITECTURE.md](ARCHITECTURE.md). Each milestone is one GitHub issue (label `milestone`), one branch and one PR, shipped with `/ship`. It meets the Definition of done in CLAUDE.md and gets a `/review-milestone` pass before merge.

## How the plan retires the top risks early

| Risk | Retired in |
|---|---|
| $20 runs out mid-review | OpenAI's hard $20 limit on the key is the backstop; cheap guards in the env schema (M1); kill switch, per-IP limit and daily session cap (M5); client timers and dev-only cost overlay (M6); cost model corrected from measured usage (M6); fail-closed limiter (M10); 2.1 switched on only after the numbers fit (M13) |
| YouTube fails on the deployed app | Provider chain and cache (M3); block observed on a preview in M3; Supadata, folded in from the old M12 (M3) |
| Live voice misbehaves on real phones | Live checkpoint that records fixtures and settles every UNVERIFIED API fact before UI work (M6); real-device checks (M7, M8) |
| Instability on a poor network | `reconnecting` state from the first reducer (M6); full reconnect and retries (M9) |
| PDF path breaks only when deployed | Vercel Git previews (M1); 20 MB Blob smoke test on a preview (M2) |

## Live API checkpoints

Every live call is asked for first and kept short. Costs are estimates on gpt-realtime-2.1-mini unless noted. After each one, the real cost from the OpenAI usage page goes in AI_LOG.md.

| Milestone | Checkpoint | Est. cost |
|---|---|---|
| M5 | One `client_secrets` mint to confirm the response shape | $0 (documented as free) |
| M6 | ~2 min session: record event fixtures, settle UNVERIFIED items | ~$0.05 |
| M7 | Phone check of voice and text UI on a preview | ~$0.10 |
| M8 | iPhone Safari and Android Chrome polish pass | ~$0.10 |
| M9 | One network drop and reconnect on a phone | ~$0.10 |
| M11 | Production smoke on mini | ~$0.10 |
| M13 | Switch production to gpt-realtime-2.1 and 20k; QA and video | ≤ $4 (QA envelope) |

Build envelope: $4. Planned checkpoints ≈ $0.45.

---

## M1 Foundations

**Scope**
- Add dependencies, each with a one-line justification in the PR: `zod` (boundary validation), `server-only` (import guard), `vitest` + `@vitest/coverage-v8` (unit tests), `@testing-library/react` + `@testing-library/user-event` + `jsdom` (component tests), `@playwright/test` (e2e), `prettier` (format), shadcn/ui init + `lucide-react` (UI kit and icons).
- Scripts: `check` (lint + typecheck + unit tests), `test`, `test:e2e`, `format`, `typecheck`.
- `src/server/env.ts`: the full zod schema from ARCHITECTURE §8, including every cost guard (`REALTIME_MODEL`, `CONTEXT_TOKEN_BUDGET`, `VOICE_ENABLED`, `MAX_SESSION_MINUTES`, `DAILY_SESSION_CAP`). Cross-field rules: `memory` and `direct` refused when `VERCEL_ENV` is set; `fixture` provider refused in production; required secrets per mode.
- `src/lib/errors/catalog.ts` with every code and copy from SPEC §4. `src/server/errors` AppError. `src/server/http` route helper (zod parse, AppError mapping, request id, salted IP hash). `src/server/log.ts` with redaction.
- Adapter interfaces for DocumentStore and RateLimiter (sliding window plus a daily fixed-window counter keyed by UTC date), memory implementations, and one shared contract suite that every implementation must pass.
- Security headers in `next.config.ts` (SPEC §8.1); CSP starts strict and gains hosts in later milestones.
- `GET /api/health`. ESLint `no-restricted-imports` rules from ARCHITECTURE §2. `.env.example` with every variable and a comment.
- GitHub Actions: install, `pnpm check`, `pnpm build`. Vercel project connected to the repo for Git preview deployments (no secrets yet, no OpenAI key on Vercel).
- README skeleton: setup, run, test.

**Acceptance criteria**
- [ ] `pnpm check` passes locally and in CI.
- [ ] A push to a branch produces a Vercel preview URL, and `/api/health` returns `{ ok: true }` there.
- [ ] Missing or invalid env fails fast at boot with a readable message that never prints a secret value.
- [ ] Importing `src/server/**` from a client module fails lint.

**Tests**
- [ ] `src/server/env.test.ts`: defaults (mini, 8k), invalid model rejected, `memory` refused on Vercel, `fixture` refused in production, secrets never in error text.
- [ ] `src/server/http/route-helper.test.ts`: zod failure → `invalid_request`; AppError → catalog status and copy; unknown error → `internal` with no upstream message.
- [ ] `src/server/adapters/*.contract.test.ts` against memory: TTL expiry, sliding window, daily counter (cap, independent keys, UTC day rollover).
- [ ] `src/server/log.test.ts`: redaction of keys and tokens.
- [ ] `next.config` headers test (CSP, HSTS, Permissions-Policy present).

## M2 PDF pipeline

**Scope**
- Add `unpdf` (serverless pdf.js with per-page text) and `@vercel/blob` (browser-direct upload past the 4.5 MB body cap).
- `src/server/ingest/pdf/validate.ts`: size, empty, `%PDF-` magic bytes.
- `src/server/ingest/pdf/extract.ts`: unpdf, one page at a time; page cap 2,000; 55 s budget; at most 2 extractions at once; mapping of `PasswordException` and invalid-PDF errors; scanned and partial-text detection.
- `src/server/ingest/pdf/normalize.ts`: ligatures, per-range Arabic presentation forms, end-of-line hyphenation, whitespace and control chars.
- `src/server/upload`: Blob token policy (`application/pdf`, 25 MB, `addRandomSuffix`, 5 min `validUntil`, nonce in `tokenPayload`) and the direct multipart reader with a streaming 25 MB abort.
- Ingest service: idempotency key, stream NDJSON (`meta`, `unit`…, `done` or `error`), save to DocumentStore, delete the blob in `finally`.
- Routes `POST /api/upload/token` and `POST /api/ingest/pdf` with `maxDuration = 60` and no `runtime` or `dynamic` export (both are rejected under Cache Components). `GET /api/documents/[id]` and the idempotent retry move to a later milestone.
- `scripts/make-fixtures.ts` builds text, multi-language, ligature, hyphenation, empty-page and 2,001-page PDFs. Committed binaries cover encrypted, owner-password-only, corrupted and scanned files. Each fixture's source is noted in `test/fixtures/README.md`.
- Private Blob store created for previews with the RW token; CSP adds the upload host.

**Acceptance criteria**
- [ ] Every PDF edge case in SPEC §5.1 returns its catalog code or the specified behavior.
- [ ] **On a Vercel preview, a 20 MB text PDF uploaded through Blob extracts every page into NDJSON, and the blob is gone from the dashboard afterwards (MC-1).**
- [ ] A broken stream retried with the same key returns the stored document without re-extracting.
- [ ] No PDF bytes pass through a function body in blob mode.

**Tests**
- [ ] `validate.test.ts`: oversize, empty, wrong magic bytes, magic bytes after junk ≤ 1,024 bytes.
- [ ] `extract.test.ts`: normal, encrypted, owner-password-only, corrupted, scanned, partial, too many pages, timeout (fake clock), Arabic, CJK, Cyrillic, Devanagari.
- [ ] `normalize.test.ts`: each ligature, Arabic presentation forms, hyphen join and keep rules, whitespace.
- [ ] `upload/token.test.ts`: content type, size, suffix, expiry, nonce in payload, rate limit.
- [ ] `ingest-service.test.ts`: NDJSON framing, error line after a partial stream, blob deleted on success and failure, idempotent retry.
- [ ] `src/app/api/ingest/pdf/route.test.ts`: zod rejection, pathname prefix and nonce checks, direct mode refused on Vercel.

## M3 YouTube pipeline (direct + Supadata, works deployed)

**Scope**
- `parse-url.ts` from reference §4, plus playlist, channel and `@handle` detection for `youtube_no_video_id`.
- `TranscriptProvider` interface with a typed result union: `ok | terminal error | retryable error`. `chain.ts` falls through only on retryable errors (`youtube_blocked`, `youtube_failed`).
- `direct.ts`: watch page, consent wall, InnerTube key, ANDROID player request, `playabilityStatus` mapping (reference §2), live and upcoming detection, track pick order from SPEC §5.2, `&exp=xpe` check, caption fetch, hand-written XML parser that rejects DTDs. Every fetch has a timeout.
- `fixture.ts` provider for e2e (refused in production).
- Service: merge lines into ~30 s paragraphs with `[mm:ss]`, group into ~5-minute units, length cap, cache by `videoId+lang` with a 24 h TTL, NDJSON route `POST /api/ingest/youtube`.
- `supadata.ts` (folded in from the old M12): `GET /v1/transcript` with the canonical URL, `mode=native`, `text=false` (timestamps), explicit 206 handling, defensive 202 job polling with a cap, error mapping from reference §3, 15 s timeout.
- Global 1 req/s limiter and a monthly credit counter (`SUPADATA_MONTHLY_CAP`); `youtube_quota` when hit.
- Measure on a preview and on production whether the direct provider ever succeeds from Vercel; set `YOUTUBE_PROVIDERS` for production from that measurement.
- README: "YouTube on Vercel" section explaining the cloud-IP block, the chain, the cache and the free-plan limits.
- Recorded fixtures (HTML, player JSON, caption XML) for each case, captured once locally, with tracking params removed.

**Acceptance criteria**
- [ ] Locally, a captioned public video loads with timestamps (MC-2).
- [ ] On a preview, a direct-only chain yields a clean `youtube_blocked` error line (expected on cloud IPs), never a crash or upstream text; with Supadata in the chain the same video loads.
- [ ] MC-7 passes on production: three captioned videos (long, non-English, auto-captions only).
- [ ] A second paste of the same video makes no Supadata call.
- [ ] Credits used during the review stay under the monthly cap by design.
- [ ] Every YouTube edge case in SPEC §5.2 except Supadata-specific rows maps to its behavior.
- [ ] Pasting the same video twice makes one upstream fetch.

**Tests**
- [ ] `parse-url.test.ts`: ≥ 20 positive shapes, every negative in reference §4, playlist, channel, handle.
- [ ] `direct.test.ts`: OK, consent wall once and twice, 429, recaptcha, bot check, age restricted, unavailable, other unplayable, live, upcoming, no captions, PO token, unparsable HTML.
- [ ] `pick-track.test.ts`: language preference order, manual before generated, same-code collision.
- [ ] `captions-xml.test.ts`: entities, tags stripped, missing `dur`, empty lines skipped, DTD rejected, billion-laughs input rejected.
- [ ] `chain.test.ts`: terminal stops, retryable falls through, all fail → last retryable code.
- [ ] `supadata.test.ts`: recorded 200, 206, 202 then completed, 202 then failed, 400, 401, 402, 403, 404, 429, 500, 502, timeout.
- [ ] `chain.test.ts` additions: direct blocked → Supadata ok; Supadata quota → `youtube_quota`.
- [ ] `youtube-service.test.ts`: paragraphs and units, cap, cache hit.

## M4 Ingestion UI

**Scope**
- Ingest screen per SPEC §3.1: segmented PDF / YouTube, file picker with client checks, URL field, upload progress with Cancel (blob mode) and Retry.
- `src/features/ingest/ndjson-reader.ts`: pure parser over a `ReadableStream`, validated with the `src/lib/wire` schemas, which detects a missing `done`.
- Progressive page render while extracting ("Reading page 37 of 120…").
- Document screen `/d/[id]` per SPEC §3.2: header, source chip, coverage and other notices, collapsible full text with `content-visibility: auto`, expired-document state, bottom bar placeholders for voice and text.
- Playwright config: 390x844, Chromium, `UPLOAD_MODE=direct`, `YOUTUBE_PROVIDERS=fixture`, `STATE_DRIVER=memory`. A Chromium e2e job is added to CI.

**Acceptance criteria**
- [ ] Both sources reach the document screen in e2e, and every SPEC §3.1 state is visible at least once.
- [ ] Every ingestion error in SPEC §4.1 shows its exact copy and the matching retry action.
- [ ] A 2,000-page preview expands and scrolls without jank (manual check with the performance panel).
- [ ] Screenshots at 390x844 reviewed with the playwright MCP.

**Tests**
- [ ] `ndjson-reader.test.ts`: split chunks, multi-byte UTF-8 across chunks, bad line, missing `done`.
- [ ] `text-preview.test.tsx`: collapsed and expanded, markers, text rendered as text (no HTML injection).
- [ ] `e2e/ingest-pdf.spec.ts`: happy path, oversize, not a PDF, encrypted, scanned.
- [ ] `e2e/ingest-youtube.spec.ts`: happy path, bad URL, playlist URL, no captions, auto-captions notice, language notice.
- [ ] `e2e/states.spec.ts`: idle, working, success and error-with-retry for both sources.

## M5 Session endpoint and context

**Scope**
- Add `gpt-tokenizer` (local token counts for the budget, with no API call).
- `src/server/context`: token count, budget cap by whole units, last-unit cut, markers, `<reference_material>` fence with escaping, title sanitizing, `<conversation_so_far>` fence for reconnects, coverage object.
- `src/server/realtime/client-secrets.ts`: adapter with 10 s timeout, typed errors (billing codes from reference §3, 4xx config, 5xx busy), never logs the key.
- `src/server/guard`: kill switch, IP limit (fail closed), `DAILY_SESSION_CAP` via `RateLimiter.countDaily`.
- `src/server/session/service.ts` and `POST /api/session` (enforces `VOICE_ENABLED`, the per-IP limit and `DAILY_SESSION_CAP`; maps OpenAI's quota or billing-limit error to 503 `budget_exhausted`); `GET /api/limits`.
- **[LIVE: ask first, $0]** one mint to confirm the response shape; recorded as a fixture with the secret value replaced.

**Acceptance criteria**
- [ ] The session response contains only `clientSecret`, `expiresAt`, `sessionId`, `model`, `coverage` and `limits`, never the API key or instructions.
- [ ] Each guard in SPEC §7.4 trips with its exact code and copy.
- [ ] Instructions for an 8k and a 20k budget have the expected coverage and stay under budget by token count.
- [ ] A document containing `</reference_material>` and "ignore all previous instructions" stays inside the fence.

**Tests**
- [ ] `budget.test.ts`: under budget, exact fit, unit cut, single huge unit, empty document.
- [ ] `build-instructions.test.ts`: fence shape, escaping variants (case, spaces), title sanitizing, reconnect fence and its cap, injection fixtures.
- [ ] `client-secrets.test.ts`: recorded 200, 400, 404, 429 with each billing code, 5xx, timeout.
- [ ] `guard.test.ts`: every trip, limiter timeout denies, reconnect does not count against the daily cap.
- [ ] `src/app/api/session/route.test.ts`: zod, unknown document, each guard code, billing error → 503 `budget_exhausted`.

## M6 Realtime engine

**Scope**
- `transport.ts` interface; `webrtc-transport.ts` (peer connection, `oai-events` channel created before the offer, mic track with echo cancellation, noise suppression and AGC, recvonly or silent track for text mode, `/v1/realtime/calls` exchange with `res.ok` check, ICE and channel state events); `mock-transport.ts` (scripted and fixture replay).
- `events.ts`: zod schemas for every server event in reference §3; unknown types become `ignored`.
- `reducer.ts`: the state machine in ARCHITECTURE §6, the transcript model ordered by `previous_item_id`, interruption marking, recoverable vs fatal errors.
- `use-realtime-session.ts`: mint, connect, max-session, idle and hidden-tab timers, Stop (`response.cancel` then `output_audio_buffer.clear`), mute (`track.enabled`), send text, full cleanup.
- Dev-only cost overlay (`src/features/voice/dev-cost`): price table with fetch date, estimates tokens and cost from `response.done` and transcription usage, tested by hand-priced fixtures; stripped from production, nothing reported to the server.
- **[LIVE: ask first, ~2 min on mini, ~$0.05]** record real event logs into `test/fixtures/realtime/` and settle: the recvonly offer for no mic, `output_modalities` on `response.create`, the `/calls` success status and `Location` header, the error shape for billing. Update reference §2 and §3 and the cost model in SPEC §7.2 with measured numbers.

**Acceptance criteria**
- [ ] Replaying the recorded fixtures through the mock transport produces the right transcript and states.
- [ ] Every UNVERIFIED item in reference §2 is resolved and the reference updated.
- [ ] No leak after 20 start/end cycles in a test (tracks stopped, connections closed, timers cleared).

**Tests**
- [ ] `events.test.ts`: every handled event parses; unknown and malformed events are ignored, not thrown.
- [ ] `reducer.test.ts`: every transition in the diagram, out-of-order transcription, barge-in (`turn_detected`), client cancel, `response.done` statuses, recoverable error, fatal billing error, reconnect entry and exit.
- [ ] `webrtc-transport.test.ts` with a fake `RTCPeerConnection`: channel before offer, non-OK SDP response, ICE events mapped, close releases everything.
- [ ] `use-realtime-session.test.ts`: mint failure, guard error, usage posted per response, timers end the session, cleanup on unmount.

## M7 Voice and text UI

**Scope**
- Chat panel on `/d/[id]` per SPEC §3.3 and §3.4: **Start Voice Chat**, status pill, mic level meter (AnalyserNode), Mute/Unmute, Stop speaking, End, Type instead.
- Transcript as an `aria-live="polite"` log with auto-scroll and Jump to latest; interrupted marker.
- Text mode composer pinned above the keyboard using `visualViewport`; automatic switch on `mic_denied`, `mic_not_found` and `mic_in_use`.
- Session timer with the 1-minute warning; every session and budget error card from SPEC §4.2 and §4.3; Start disabled up front when `/api/limits` reports a trip.
- e2e builds use `NEXT_PUBLIC_REALTIME_TRANSPORT=mock`.
- **[LIVE: ask first, ~$0.10]** phone check on a preview: ask, interrupt, follow up (MC-3).

**Acceptance criteria**
- [ ] Every state in SPEC §3.3 and §3.4 is reachable in e2e with the mock transport.
- [ ] Mic denied in WebKit lands in text mode with the exact copy.
- [ ] Controls are at least 44 px and labeled for screen readers.
- [ ] Screenshots at 390x844 reviewed with the playwright MCP.

**Tests**
- [ ] `controls.test.tsx`, `status-pill.test.tsx`, `transcript.test.tsx`, `composer.test.tsx`.
- [ ] `e2e/voice.spec.ts` (Chromium fake media): start, speak (scripted), interrupt, end, every budget error.
- [ ] `e2e/text-mode.spec.ts` (WebKit, no mic): automatic fallback, send, streamed reply, retry on failure.

## M8 Mobile polish

**Scope**
- Layout audit at 390x844 and 360x740: `100dvh`, safe-area insets, bottom bar within thumb reach, no horizontal scroll, long titles truncate.
- Keyboard overlap on iOS and Android; focus order; visible focus rings; reduced motion.
- iOS audio: `play()` on the remote audio element inside the tap gesture; speaker output; resume after an interruption such as a phone call.
- Screen Wake Lock during a session, released on end and when hidden.
- Add `@axe-core/playwright` (automated a11y checks in e2e).
- **[LIVE: ask first, ~$0.10]** iPhone Safari and Android Chrome pass (MC-4).

**Acceptance criteria**
- [ ] axe reports no serious or critical issues on every screen.
- [ ] MC-4 passes on both phones: safe areas, keyboard, rotation, lock and unlock.
- [ ] Screenshots of every screen and state at 390x844 reviewed and attached to the PR.

**Tests**
- [ ] `e2e/layout.spec.ts`: axe per screen, no horizontal overflow, tap target sizes, reduced-motion snapshot.
- [ ] `wake-lock.test.ts`: acquire, release on end and on hidden, unsupported browser.

## M9 Network resilience

**Scope**
- Reconnect per ARCHITECTURE §5.4: 5 s grace on `disconnected`, reconnect on `failed`, on channel close or when offline, backoff 1/2/4 s, 3 attempts, same session record, transcript carried in the `conversation_so_far` fence.
- Offline banner from `navigator.onLine` and `online`/`offline` events; wait for `online` before re-minting.
- Mint retries with jitter for 5xx and timeouts only; billing and guard errors never retried.
- Ingest: retry with the same idempotency key when a stream ends without `done`; upload Retry after an aborted PUT.
- **[LIVE: ask first, ~$0.10]** airplane mode for 5 s and 30 s, and a Wi-Fi to cellular switch (MC-5).

**Acceptance criteria**
- [ ] A 5 s drop recovers without a new session; a 30 s drop reconnects with the transcript intact; a permanent drop ends in `session_reconnect_failed` with Retry.
- [ ] A broken ingest stream recovers without the user doing anything.
- [ ] A reconnect does not count against `DAILY_SESSION_CAP`.

**Tests**
- [ ] `reconnect.test.ts` (mock transport): grace recovery, failed → reconnect, 3 failures, offline wait, billing error during reconnect.
- [ ] `e2e/network.spec.ts`: `context.setOffline` mid-session, aborted NDJSON route, throttled upload via CDP (Chromium), offline banner.
- [ ] Session service test: reconnect reuses the session record and caps the transcript excerpt.

## M10 Security and cost guard

**Scope**
- Add `@upstash/redis` and `@upstash/ratelimit` (shared state on serverless, free plan).
- Upstash implementations of the two adapters per ARCHITECTURE §4; the contract suite runs against Upstash only when local Upstash env is present (skipped in CI).
- Apply the limits matrix to every handler; fail closed for mint and upload.
- Final CSP; `GET /api/cron/cleanup` with `CRON_SECRET` and a daily Vercel cron.
- CI: gitleaks job; `scripts/check-bundle-secrets.ts` on the client build output; `pnpm audit` (warn).
- Run `/security-review` and fix the findings; walk the SPEC §8.2 threat list and link each row's test.

**Acceptance criteria**
- [ ] Every threat T-01 to T-16 has a passing test or a documented CI check.
- [ ] Contract suite passes against memory in CI and against Upstash locally.
- [ ] A burst of 30 mint requests from one IP gets 6 secrets and then `budget_ip_rate`.

**Tests**
- [ ] `*.contract.test.ts` for Upstash adapters (local only).
- [ ] `guard.test.ts` additions: limiter timeout, daily cap across a UTC day change.
- [ ] `cron/cleanup.test.ts`: auth required, only `uploads/` older than 1 h deleted.
- [ ] Bundle secret check fails on a planted fake key (self-test).

## M11 Vercel deploy

**Scope**
- Production project settings: Node runtime, region near OpenAI (default `iad1`), Standard Deployment Protection (previews behind Vercel Authentication, production public).
- Private Blob store with an RW token for Production and Preview; Upstash Redis free plan through the Marketplace; `vercel env pull` to read the real variable names (never printed).
- Env per environment from ARCHITECTURE §8. Production stays on mini and 8k until M13.
- Confirm the Blob upload hosts in the Network panel and tighten CSP to them.
- Production smoke checklist (no OpenAI call by default): health, limits, PDF 20 MB and 300 pages (MC-6), YouTube error path.
- README: deploy section, environment table, limitations.
- **[LIVE: ask first, ~$0.10]** one short voice chat on production.

**Acceptance criteria**
- [ ] The production URL is public and passes MC-6.
- [ ] Preview URLs require Vercel login; the reviewer gets the production URL only.
- [ ] No secret is visible in the client bundle, response headers or logs (spot check plus the CI bundle check).
- [ ] The Blob dashboard shows zero stored blobs after the smoke test.

**Tests**
- [ ] `e2e/smoke.prod.spec.ts` (manual run only, never in CI): health, limits, PDF ingest.
- [ ] `env.test.ts` additions: production rules (`blob`, `upstash`, no `fixture`).

## M13 Test hardening and CI e2e

**Scope**
- CI e2e on Chromium and WebKit at 390x844 with the mock transport and fixture providers; sharded if needed; traces and screenshots uploaded on failure.
- Coverage thresholds: `src/server/**` ≥ 85% lines, `reducer.ts` 100% branches.
- Flake check: `--repeat-each=3` on the e2e suite before release.
- Fill any SPEC matrix row whose proof is still missing.
- Review-script dry run on production, steps RS-1 to RS-5, by hand.
- **[LIVE: ask first, ≤ $4]** switch production to `gpt-realtime-2.1` and `CONTEXT_TOKEN_BUDGET=20000`, run QA, record the walkthrough video (MC-10).
- Final README: overview, architecture link, trade-offs, AI-use note, `gpt-4o-mini-transcribe` sunset note.
- Video outline: demo of PDF and YouTube ingest, preview, voice chat with an interrupt, text fallback; then framework choice, backend and hosting, Realtime integration (ephemeral secret, WebRTC, events, reducer), cost guards, libraries and AI tools.

**Acceptance criteria**
- [ ] CI is green on Chromium and WebKit, three repeats without a flake.
- [ ] Every SPEC matrix row has a passing proof.
- [ ] The review-script dry run passes on production with gpt-realtime-2.1.
- [ ] OpenAI usage dashboard after QA shows about $4 or less spent, leaving ≥ $10 for review.

**Tests**
- [ ] CI e2e matrix (Chromium, WebKit).
- [ ] Coverage gate in `pnpm check` CI step.
- [ ] Manual RS-1 to RS-5 checklist recorded in the PR.
