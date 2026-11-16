# Argon Review Report

## Overview

This report covers the second-reviewer ("Argon") audit of the `talk-to-doc` codebase against `docs/SPEC.md` and `CLAUDE.md`, alongside a mobile browser walkthrough on the live deployment (`https://talk-to-doc-seven.vercel.app/`) at `390x844` and `390x420` viewports.

---

## 1. Area-by-Area Audit Summary

### 1.1 Realtime Client (`src/features/voice/realtime`)
- **GA WebRTC protocol & transport (`webrtc-transport.ts`, `events.ts`, `client-events.ts`)**: Uses the GA endpoint `https://api.openai.com/v1/realtime/calls`, parses both GA and beta wire event aliases (`conversation.item.added`, `response.output_audio.delta`, `response.output_audio_transcript.delta`, `output_audio_buffer.started/stopped/cleared`), and caps inbound data-channel frames at `256 KB`.
- **Ordering & state reducer (`reducer.ts`, `transcript.ts`)**: Maintains an `epoch`-scoped `previous_item_id` linked list with `arrivalSeq` tie-breaking so late user input-audio transcriptions still render above the assistant reply they triggered. Barge-in (`input_audio_buffer.speech_started`) and manual stop (`local-stop`) freeze the assistant bubble at the heard prefix and ignore trailing deltas from cancelled responses.
- **Session lifecycle & reconnect (`session.ts`, `reconnect.ts`)**: Enforces the 5-minute session cap (with a 60-second warning at 4:00) and 2-minute idle timeout, and handles transient WebRTC drops (`grace` -> `minting` -> `negotiating` -> `cooldown`, up to 3 attempts) while preserving transcript history and re-seeding up to 30 prior turns.
- **Issues found**: Two state-machine edge cases in `reducer.ts` (see **Should fix #1** and **Should fix #2**, both fixed in this branch).

### 1.2 Session Route & Context Fencing (`src/app/api/realtime/session/route.ts`, `src/server/session/*`, `src/server/context/*`)
- **Validation & rate limiting**: `POST /api/realtime/session` enforces per-IP rate limiting (`10 / min`, failing closed with `503 service_unavailable` if the store throws) before body parsing, validates `SessionRequestSchema` with `.strict()` under a `512 KB` body cap, and verifies the `documentId` exists in `DocumentStore`.
- **Ephemeral token minting (`createClientSecret.ts`)**: Mints a 60-second ephemeral `ek_...` secret against `POST https://api.openai.com/v1/realtime/client_secrets` with `model: "gpt-realtime"`, `voice: "marin"`, `semantic_vad` (`eagerness: "medium"`, `create_response: true`, `interrupt_response: true`), `noise_reduction: { type: "near_field" }`, and `gpt-4o-mini-transcribe`.
- **Prompt-injection fencing (`buildInstructions.ts`, `document.ts`)**: Wraps untrusted document content and reconnect history inside a per-mint random `<document_${nonce}>` / `<conversation_history_${nonce}>` fence, strips any literal closing fence tags (`stripClosingFence`) and bidi/control characters (`cleanTitle`) from document titles, text, and history turns, and instructs the model to treat everything inside the fence strictly as data.

### 1.3 YouTube Provider Chain (`src/server/ingest/youtube/*`, `src/lib/youtube/*`)
- **URL parsing & SSRF prevention (`parseUrl.ts`, `direct.ts`)**: Strict host allowlist (`youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtube-nocookie.com`, `www.youtube-nocookie.com`, `youtu.be`), 11-character video ID validation (`[A-Za-z0-9_-]{11}`), `redirect: "error"` on every upstream fetch, and caption track URL verification (`https://www.youtube.com/api/timedtext`).
- **Provider chain & budgets (`index.ts`, `direct.ts`, `supadata.ts`, `guard.ts`)**: Runs `direct` (Innertube `ANDROID` player with `12 s` deadline) followed by `supadata` (`15 s` deadline, `202` job polling rejected as `UPSTREAM_TIMEOUT`, guarded by an `80 / day` shared counter) under a `25 s` total chain deadline.
- **XML safety (`captionsXml.ts`)**: Rejects `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, and `<!ATTLIST` before parsing and performs non-recursive entity decoding.
- **Issues found**: Single-quoted XML attributes in `captionsXml.ts` (**Should fix #3**) and cache-before-length-validation ordering in `request.ts` (**Should fix #4**), both fixed in this branch, plus minor buffer/query-string cleanup items in `direct.ts` (**Nice to have #11**).

### 1.4 PDF Pipeline (`src/server/ingest/pdf/*`, `src/app/api/ingest/pdf/route.ts`, `src/app/api/upload/token/route.ts`, `src/app/api/cron/cleanup/route.ts`)
- **Dual-mode ingestion (`request.ts`, `multipart.ts`, `blob.ts`, `upload-token.ts`)**: Supports direct `multipart/form-data` in local development and single-use signed Vercel Blob tokens (`maximumSizeInBytes: 25 MB`, `allowedContentTypes: ["application/pdf"]`, 5-minute TTL) in production, with strict blob URL verification against the store's `*.private.blob.vercel-storage.com` hostname (`redirect: "error"`), a `finally` block that deletes the blob on every code path, and `/api/cron/cleanup` gated by constant-time `CRON_SECRET` comparison.
- **Validation & extraction (`validate.ts`, `extract.ts`, `normalize.ts`)**: Verifies `%PDF-` magic bytes, blocks `/Encrypt` dictionaries before parser invocation, limits concurrent extractions to 2 per instance via a deadline-aware semaphore, caps pages at 500, and streams normalized page text as NDJSON before storing the token-capped context.
- **Issues found**: `readTitle(pdf)` (`getMeta(pdf)`) in `extract.ts` was not wrapped in `raceDeadline` (**Should fix #5**, fixed in this branch).

### 1.5 Security (`src/server/env.ts`, `src/server/http.ts`, `src/server/security/*`, `src/lib/security-headers.ts`, `scripts/check-bundle-secrets.ts`)
- **Secret isolation**: `src/server/env.ts` is marked `import "server-only"`; ESLint rules forbid client imports of `src/server/*`, forbid `process.env` outside `src/server/env.ts` and `src/lib/public-env.ts`, and forbid `dangerouslySetInnerHTML` (`react/no-danger: "error"`). `scripts/check-bundle-secrets.ts` scans `.next/static` for secret env var names, live secret values, and `sk-`/`sd_`/`upstash.io` patterns.
- **Headers & rate limits**: CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Permissions-Policy: microphone=(self), camera=(), geolocation=()` are set on all routes; every API route rate-limits before reading the body and logs only structured metadata (`requestId`, `route`, `status`, `durationMs`, `code`, `provider`).

### 1.6 Mobile Voice Screen & Document UI (`src/features/voice/ui/*`, `src/features/document/*`, `src/features/ingest/*`)
- **Walked live on `https://talk-to-doc-seven.vercel.app/` at `390x844` and `390x420`**:
  - **Captioned YouTube URL (`390x844`)**: Tested `https://www.youtube.com/watch?v=aircAruvnKk` (3Blue1Brown, 18m 30s, 37 segments, 17,448 words). Streaming NDJSON progress and full-text timestamp groups (`00:00 – 05:00`, deep links to YouTube with `t=...s`) worked cleanly with zero horizontal overflow (`scrollWidth: 390`).
  - **Sample PDF (`390x844`)**: Tested *Introduction to the 1992 Edition--US Constitution* (4 pages, 1,197 words) and full-text sheet (`Page 1`–`Page 4`).
  - **Voice / text session, grounding chips & transcript export (`390x844`)**: Tested both `"Type instead"` (`mode: "text"`) and `"Start voice chat"` (`mode: "voice"`). Tapping the `[page 3]` grounding chip in the assistant's reply opened the full-text sheet directly to Page 3 with highlight. Both `"Copy"` and `"Download"` exported a well-formatted Markdown transcript (`introduction-to-the-1992-edition-us-constitution-2026-11-15.md`).
  - **Compact keyboard layout (`390x420`)**: Focusing the composer input at `390x420` collapsed the document card and audio visualizer into a single slim status row, keeping the transcript and composer (`Send` button `44x44px`) comfortable and reachable.
  - **Issues noted**: Full-text sheet copy lacked the `copyText` fallback used by transcript export (**Should fix #6**, fixed in this branch); on the `390x844` document-ready screen, the sticky bottom `ReadyBar` covers the `"Show full text"` button until the user scrolls (**Should fix #7**, left for the other reviewer); and in a muted voice chat, the status pill stays `"Muted"` while the assistant is thinking/responding to a typed question (**Nice to have #9**, left for the other reviewer).

---

## 2. Findings

### Blockers

None. No release-blocking defects, crashes, or security vulnerabilities were found.

---

### Should Fix

#### 1. Failed active response leaves `response.audioId` set, wedging `activity` on `"assistantSpeaking"` and disabling the idle timer
- **Location**: `src/features/voice/realtime/reducer.ts:519-522`
- **Status**: `fixed in this branch`
- **Problem**: When `output_audio_buffer.started` sets `state.response.audioId = response_id` and `state.activity = "assistantSpeaking"` (`reducer.ts:676-685`), and that response subsequently terminates with `response.done` having `status: "failed"` without a trailing `output_audio_buffer.stopped` or `.cleared`, `onResponseDone` cleared `activeId: null` and called `settleActivity(s)`. Because `settleActivity` (`reducer.ts:206`) returns immediately whenever `state.response.audioId !== null`, `state.activity` remained stuck on `"assistantSpeaking"` ("Speaking" status pill) and `VoiceSession.isBusy()` (`session.ts:1120-1127`) returned `true` indefinitely, preventing the 2-minute idle timer (`IDLE_MS`) from ever firing.
- **Fix**: Clear `audioId` to `null` when `status === "failed"` inside `onResponseDone` (`src/features/voice/realtime/reducer.ts:519-523`) before calling `settleActivity(s)`, with unit test coverage in `src/features/voice/realtime/reducer.test.ts`.

#### 2. Stale `state.notice` (`cap_warning` or `error`) remains visible on `ended`, `failed`, and `session_expired` reconnect screens
- **Location**: `src/features/voice/realtime/reducer.ts:298-309` and `src/features/voice/realtime/reducer.ts:752-760`
- **Status**: `fixed in this branch`
- **Problem**:
  1. In `applyConnection` (`reducer.ts:295-309`), `notice: null` was only cleared on `case "connected":`, not on `case "ended":` or `case "failed":`. When the 1-minute warning (`cap_warning`) fired at 4:00 and the session ended at 5:00 (`reason: "max_duration"`), `ConversationScreen` (`conversation-screen.tsx:147, 177-190, 310`) switched to `slim = true` and rendered `"About 1 minute left in this chat."` at the top of the transcript while the bottom `EndedPanel` simultaneously displayed `"This chat reached its 5-minute limit."` Similarly, any mid-session recoverable error notice remained pinned after the session ended or failed.
  2. When a `session_expired` server error arrived (`session.ts:669-678`), `this.dispatch({ type: "server", event })` set `state.notice = { kind: "error", code: "session_expired" }` before `onLinkDead("session-expired")` dispatched `reconnect-settle`, leaving `"The service reported a problem. You can keep going or end the chat."` visible alongside the reconnecting banner.
- **Fix**: Clear `notice: null` in `applyConnection` for `"ended"` and `"failed"` transitions, and clear error notices (`state.notice?.kind === "error" ? null : state.notice`) in `reconnect-settle`, with unit tests in `src/features/voice/realtime/reducer.test.ts`.

#### 3. Caption XML attribute regex only matches double-quoted attributes (`="..."`), dropping single-quoted `<text start='...' dur='...'>` elements
- **Location**: `src/server/ingest/youtube/captionsXml.ts:79-91`
- **Status**: `fixed in this branch`
- **Problem**: `const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;` only matched double-quoted XML attributes. Valid XML caption tracks using single-quoted attributes (`<text start='12.34' dur='2.5'>`) failed attribute extraction (`start` parsed as `NaN`), silently skipped every `<text>` node (`captionsXml.ts:125`), and caused the provider to fail with `NO_CAPTIONS` (`youtube_no_transcript`).
- **Fix**: Update `ATTRIBUTE` in `src/server/ingest/youtube/captionsXml.ts:79` to match both double-quoted and single-quoted attribute values (`/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g`), with unit test coverage in `src/server/ingest/youtube/captionsXml.test.ts`.

#### 4. `ingestYoutube` writes transcripts to the 1-hour `DocumentStore` cache before running `assertNotTooLong`
- **Location**: `src/server/ingest/youtube/request.ts:94-99`
- **Status**: `fixed in this branch`
- **Problem**: On a cache miss, `await writeCachedTranscript(store, videoId, lang, served)` executed at `request.ts:94` before `assertNotTooLong(served)` at `request.ts:99`. A video exceeding the 6-hour duration cap (`durationSec > MAX_DURATION_SEC`) whose serialized transcript fit under the 500 KB cache entry cap was written to `DocumentStore` (Upstash Redis) for 1 hour even though the request immediately threw `youtube_too_long`.
- **Fix**: Run `assertNotTooLong(served)` before `await writeCachedTranscript(store, videoId, lang, served)` in `src/server/ingest/youtube/request.ts`, with unit test coverage in `src/server/ingest/youtube/request.test.ts`.

#### 5. PDF metadata read (`readTitle` / `getMeta`) is not bounded by the extraction deadline (`raceDeadline`)
- **Location**: `src/server/ingest/pdf/extract.ts:187, 217-226`
- **Status**: `fixed in this branch`
- **Problem**: In `openPdf` (`extract.ts:182-200`), `getDocumentProxy`, `pdf.getPage`, and `handle.getTextContent` were all wrapped in `raceDeadline(..., deadline)`, but `const title = await readTitle(pdf)` (`line 187`, which awaited `getMeta(pdf)` at `line 221`) was not bounded by `raceDeadline`. If `getMeta(pdf)` stalled on a malformed PDF metadata stream, `openPdf` could hang past the 55-second extraction deadline without releasing its concurrency semaphore slot.
- **Fix**: Pass `deadline` to `readTitle(pdf, deadline)` and wrap `getMeta(pdf)` in `raceDeadline(getMeta(pdf), deadline)`, rethrowing `AppError` (`pdf_timeout`) while still treating non-timeout metadata errors as `undefined`, with unit test coverage in `src/server/ingest/pdf/extract.timeout.test.ts`.

#### 6. Full-text sheet `"Copy"` button calls `navigator.clipboard.writeText` directly without the `copyText` fallback
- **Location**: `src/features/document/full-text-sheet.tsx:163-170`
- **Status**: `fixed in this branch`
- **Problem**: `FullTextSheet` (`full-text-sheet.tsx:163-170`) called `await navigator.clipboard.writeText(groupsToPlainText(groups))` directly, whereas transcript export (`src/features/voice/export/export-actions.ts:45-59`) uses `copyText()`, which falls back to an off-screen `<textarea>` + `document.execCommand("copy")` in in-app mobile browsers or environments where `navigator.clipboard` is unavailable or denied.
- **Fix**: Use `copyText(groupsToPlainText(groups))` in `src/features/document/full-text-sheet.tsx:163-170`, with unit test coverage in `src/features/document/text-preview.test.tsx`.

#### 7. On the `390x844` document-ready screen, the sticky bottom `ReadyBar` initially covers the `"Show full text"` button
- **Location**: `src/features/ingest/ingest-screen.tsx:64`, `src/features/document/ready-bar.tsx:15`, and `src/features/document/text-preview.tsx:86-112`
- **Status**: `left for the other reviewer`
- **Problem**: Observed during the `390x844` browser walkthrough on `https://talk-to-doc-seven.vercel.app/`: once a YouTube video (with its 16:9 thumbnail in `DocumentCard`) or PDF finishes loading, the combined height of the page header, `DocumentCard`, and `TextPreview` (600-character excerpt + `"Show full text"` button) exceeds the area above the sticky bottom `ReadyBar` (`Start voice chat` + `Type instead` + `Use another source`), causing `ReadyBar` to occlude the `"Show full text"` button until the user scrolls down.
- **Fix**: Place a `"Full text"` action button in the top header row of `TextPreview` (next to the `"Extracted text"` heading) or reduce the collapsed preview excerpt height on compact mobile viewports so `"Show full text"` is visible above the sticky `ReadyBar` without scrolling.

#### 8. `README.md` status banner still describes only Milestones M2–M3
- **Location**: `README.md:7`
- **Status**: `left for the other reviewer`
- **Problem**: `README.md:7` reads: `"Status: PDF and YouTube pipelines (M2, M3). The server can ingest a PDF (direct upload locally, Vercel Blob when deployed) or a YouTube link and stream its text. The ingest UI and voice come in later milestones. See docs/PLAN.md."` All milestones (including ingest UI, WebRTC voice/text sessions, reconnects, security hardening, and deployment) are now complete.
- **Fix**: Update `README.md:7` to reflect the completed application and summarize the final architecture and trade-offs (`FR-DOC-02`).

---

### Nice to Have

#### 9. In a muted voice session (`state.muted === true`), the status pill stays on `"Muted"` while the assistant is thinking or speaking
- **Location**: `src/features/voice/ui/status-map.ts:108-110`
- **Status**: `left for the other reviewer`
- **Problem**: Observed during the `390x420` browser walkthrough when sending a typed message from the keyboard composer while the microphone was muted in voice mode: `statusInfo` checks `if (state.muted && state.mode === "voice") return { kind: "muted", label: "Muted", tone: "warning" }` before `switch (state.activity)` (`status-map.ts:108-110`). As a result, the status pill stays `"Muted"` instead of transitioning to `"Thinking"` or `"Speaking"` while the assistant responds (note that `src/features/voice/ui/status-map.test.ts:26` currently pins this precedence).
- **Fix**: Return `"Muted"` only when `state.activity === "listening"` (or when `state.activity !== "thinking" && state.activity !== "assistantSpeaking"`), while keeping the mute button's pressed state in `ControlBar` / `Composer` as the persistent mic-mute indicator, and update `status-map.test.ts:26`.

#### 10. `docs/DEPLOY.md` states an `8 KB` JSON body limit for `POST /api/realtime/session`, whereas the implementation allows `512 KB`
- **Location**: `docs/DEPLOY.md:13, 17` and `src/server/session/limits.ts:15`
- **Status**: `left for the other reviewer`
- **Problem**: `docs/DEPLOY.md:13` and `line 17` state `"No route accepts more than 8 KB of JSON"`, whereas `MAX_SESSION_BODY_BYTES` in `src/server/session/limits.ts:15` is `512 * 1024` (`512 KB`) to accommodate up to 30 reconnect history turns of 4,000 characters each.
- **Fix**: Update `docs/DEPLOY.md:13, 17` to note the `512 KB` body limit on `POST /api/realtime/session` (for reconnect history) and `8 KB` on `/api/ingest/youtube` and `/api/upload/token`.

#### 11. `direct.ts` buffers the full upstream body before checking `MAX_RESPONSE_CHARS` and uses `&`-prefixed substring checks on `track.baseUrl`
- **Location**: `src/server/ingest/youtube/direct.ts:122-130` and `src/server/ingest/youtube/direct.ts:196-197`
- **Status**: `left for the other reviewer`
- **Problem**: `readText(res)` calls `await res.text()` before checking `if (text.length > MAX_RESPONSE_CHARS)` instead of bounding the stream read with `readStreamCapped`; and `track.baseUrl.includes("&exp=xpe")` / `track.baseUrl.replace("&fmt=srv3", "")` assumes `exp=xpe` and `fmt=srv3` are never the first query parameter (`?exp=xpe`).
- **Fix**: Read upstream responses through `readStreamCapped` with a byte cap and use parsed `URL.searchParams` (`url.searchParams.get("exp") === "xpe"` and `url.searchParams.delete("fmt")`) when inspecting and normalizing `track.baseUrl`.
