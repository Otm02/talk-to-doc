# OpenAI Realtime (gpt-realtime-2.1 / gpt-realtime-2.1-mini) over WebRTC

Researched 2026-11-09 via the openaiDeveloperDocs MCP. GA interface only. Where a fact came from somewhere other than the docs MCP, the section says so.
Anything marked **UNVERIFIED** was not found in the docs and must be confirmed in the first live session (ask the user first, per budget rules).

## 0. Models

| | gpt-realtime-2.1 | gpt-realtime-2.1-mini |
|---|---|---|
| Type | reasoning, tool use | reasoning, tool use |
| Context window | 128,000 tokens | 128,000 tokens |
| Max output | 32,000 tokens | 32,000 tokens |
| Inputs / outputs | text, audio, image / text, audio | same |
| Features | function_calling, prompt_caching | same |
| Endpoint | realtime only | realtime only |

Sources: https://developers.openai.com/api/docs/models/gpt-realtime-2.1 , https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini

## 1. Server: mint an ephemeral client secret

`POST https://api.openai.com/v1/realtime/client_secrets`

Headers:
```
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
OpenAI-Safety-Identifier: <stable hashed id>   # recommended, not required; set HERE, it binds to the token
```

Body (`expires_after` is a sibling of `session`, not inside it):
```json
{
  "expires_after": { "anchor": "created_at", "seconds": 600 },
  "session": {
    "type": "realtime",
    "model": "gpt-realtime-2.1-mini",
    "instructions": "…server-built, fenced, untrusted-doc text…",
    "output_modalities": ["audio"],
    "reasoning": { "effort": "low" },
    "audio": {
      "input": {
        "transcription": { "model": "gpt-4o-mini-transcribe" },
        "noise_reduction": { "type": "near_field" },
        "turn_detection": {
          "type": "semantic_vad",
          "eagerness": "auto",
          "create_response": true,
          "interrupt_response": true
        }
      },
      "output": { "voice": "marin" }
    }
  }
}
```

Field facts (shapes from OpenAI's published OpenAPI spec, `openai/openai-openapi` master, which already lists gpt-realtime-2.1 and -mini; the docs-site reference page for this endpoint returned empty through the MCP):
- `expires_after.anchor`: only `created_at`. `seconds`: integer **10 to 7200**, default **600**.
- Expiry only limits when the secret can be used to *start* a session. A started session continues past it. One secret can start multiple sessions until it expires.
- `session.type`: `"realtime"` (required). A `"transcription"` type also exists; we do not use it.
- `reasoning.effort`: `minimal | low | medium | high | xhigh`, default `low`. Higher effort raises latency and output tokens. **UNVERIFIED** whether -mini accepts every level.
- `output_modalities`: `["audio"]` (default) or `["text"]`. Never both.
- `turn_detection`: `null` | `server_vad` (`threshold`, `prefix_padding_ms`, `silence_duration_ms`, `create_response`, `interrupt_response`, `idle_timeout_ms` 5000-30000) | `semantic_vad` (`eagerness`: `low|medium|high|auto`, `auto` = medium; `create_response`; `interrupt_response`). Default when omitted: `server_vad`.
- `noise_reduction`: `null` (default) | `{ type: "near_field" | "far_field", strength?: 0..1 }`. Use `near_field` for phone/headset mics.
- `audio.output.voice`: see section 6. `audio.output.speed`: 0.25 to 1.5, default 1.
- `max_output_tokens`: integer or `"inf"` (default). `truncation`: `"auto" | "disabled" | { type: "retention_ratio", retention_ratio: 0..1, token_limits: { post_instructions } }`.
- Voice cannot change after the first audio response.

Response (200):
```json
{
  "value": "ek_68af296e8e408191a1120ab6383263c2",
  "expires_at": 1756310470,
  "session": { "type": "realtime", "object": "realtime.session", "id": "sess_C9Ci…", "model": "…", "audio": { … } }
}
```
Send only `value` and `expires_at` to the browser. Errors: 400 bad config/model, 404 model unavailable to caller, 500 availability unknown.

**Does minting cost anything?** No charge is documented. The cost docs say usage accrues **per Response** (tokens) plus input transcription, and "There is no cost currently for network bandwidth or connections". The 15-second init charge in the docs applies to GPT-Live (`/v1/live/sessions`), not to Realtime client secrets. Treat minting as free, but **UNVERIFIED by a live bill**.

Sources: https://developers.openai.com/api/docs/guides/voice-webrtc (ephemeral-token section), https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime , OpenAPI spec above.

## 2. Browser: WebRTC connect with the ephemeral secret

```ts
const pc = new RTCPeerConnection();

// Remote (model) audio
const audioEl = document.createElement("audio");
audioEl.autoplay = true;
pc.ontrack = (e) => (audioEl.srcObject = e.streams[0]);

// Mic in
const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
pc.addTrack(ms.getTracks()[0]);

// Events. Label is "oai-events". Create BEFORE the offer.
const dc = pc.createDataChannel("oai-events");

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const res = await fetch("https://api.openai.com/v1/realtime/calls", {
  method: "POST",
  body: offer.sdp,
  headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" },
});
await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
```

- Request body is the raw SDP offer; response body is the raw SDP answer. Check `res.ok` before `setRemoteDescription`; the success status code is not documented (UNVERIFIED). The unified-interface example forwards a `Location` header (call id); not confirmed for the ephemeral path.
- With the ephemeral flow, session config comes from the secret. The browser may override with `session.update`.
- No client event is needed before audio flows. Adding the mic track is enough.
- No-mic fallback (our text mode): still negotiate WebRTC, but the offer needs an audio m-line. Use `pc.addTransceiver("audio", { direction: "recvonly" })` in place of the mic track. **UNVERIFIED** against the live API; docs only show the mic path. Alternative fallback is a muted/disabled mic track.
- CSP: connect-src `https://api.openai.com`. Media goes over WebRTC (UDP), not governed by CSP.
- Unified interface (`/v1/realtime/calls` with a standard API key, multipart `sdp` + `session`) puts our server in the SDP path. We do not use it, because the brief wants the browser to talk to OpenAI directly with a short-lived secret.

Send typed text:
```ts
dc.send(JSON.stringify({
  type: "conversation.item.create",
  item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
}));
dc.send(JSON.stringify({ type: "response.create" }));
```
For a text-only reply set `response: { output_modalities: ["text"] }` on `response.create`. **UNVERIFIED** field placement; confirm against the client-events reference before use. Check `dc.readyState === "open"` first; if `connecting`, wait for the `open` event.

Cancel a response and clear audio under WebRTC (order matters):
```ts
dc.send(JSON.stringify({ type: "response.cancel" }));          // -> response.done status "cancelled", reason "client_cancelled"
dc.send(JSON.stringify({ type: "output_audio_buffer.clear" })); // -> output_audio_buffer.cleared; also truncates the conversation
```
- `response.cancel` is safe with nothing in flight (returns an `error`, session unaffected). Optional `response_id`.
- `output_audio_buffer.clear` is WebRTC/SIP only and "should be preceded by `response.cancel`".
- Interruption by VAD is automatic: the server cancels, clears the buffer and truncates unplayed audio. No `conversation.item.truncate` needed on WebRTC (that is a WebSocket procedure).
- Push-to-talk on WebRTC: set `turn_detection: null`; on press send `input_audio_buffer.clear` (+ cancel/clear as above); on release `input_audio_buffer.commit` then `response.create`.

Sources: https://developers.openai.com/api/docs/guides/voice-webrtc , https://developers.openai.com/api/docs/guides/realtime-conversations , https://developers.openai.com/api/reference/resources/realtime/client-events

## 3. Server events we will handle

Every event has `event_id` and `type`. Source for all: https://developers.openai.com/api/reference/resources/realtime/server-events (unless noted).

**Session**
- `session.created` / `session.updated`: `session` object (effective config). Wait for `session.created` before sending commands. **Field list not re-read; schema is the full session object.**
- `conversation.created`: sent right after session creation (`conversation.id`).

**Input audio buffer**
- `input_audio_buffer.speech_started`: `item_id`, `audio_start_ms`. Use for UI "listening" state.
- `input_audio_buffer.speech_stopped`: `item_id`, `audio_end_ms`.
- `input_audio_buffer.committed`: `item_id`, `previous_item_id` (nullable).
- `input_audio_buffer.timeout_triggered`: only if `idle_timeout_ms` is set.

**Conversation items**
- `conversation.item.added`: `item`, `previous_item_id` (nullable). Fires when the client creates an item, when audio is committed (user message), and when the model *starts* an item (empty content, `status: "in_progress"`).
- `conversation.item.done`: `item` complete, `previous_item_id`.
- Ordering: **use `previous_item_id` to place items.** `null` = first. Arrival order is not guaranteed to match conversation order: input transcription is asynchronous and can land before or after response events.
- `conversation.item.created` still appears in the reference. Prefer `added`/`done`; ignore `created` or treat it as an alias.
- `conversation.item.truncated`, `conversation.item.deleted`: only if we send those client events.

**Input transcription** (user speech to text; separate ASR model, "a rough guide", can differ from what the model heard)
- `conversation.item.input_audio_transcription.delta`: `item_id`, `content_index`, `delta`.
- `conversation.item.input_audio_transcription.completed`: `item_id`, `content_index`, `transcript`, `usage` (`{type:"tokens", total_tokens, input_tokens, input_token_details:{text_tokens,audio_tokens}, output_tokens}` or `{type:"duration", seconds}`), optional `logprobs`, `languages` (gpt-transcribe only).
- `conversation.item.input_audio_transcription.failed`: `item_id`, `content_index`, `error:{type,code,message,param}`. Example code: `audio_unintelligible`.
- Record transcription `usage` in the UsageLedger too; it is billed separately from the response.

**Response lifecycle**
- `response.created`: `response` (id, `status: "in_progress"`). **Fields not re-read.**
- `response.done`: always emitted, whatever the outcome. `response.status`: `completed | cancelled | failed | incomplete | in_progress`. `response.status_details`:
  - `reason` (for cancelled): `turn_detected` (user spoke over it) | `client_cancelled`
  - `reason` (for incomplete): `max_output_tokens` | `content_filter`
  - `error {code,message,type}` when `failed`
  - `response.usage`: see section 4. `response.output[]`: items, no raw audio.
- `response.output_item.added` / `.done`, `response.content_part.added` / `.done`: structural; reducer may ignore.

**Output audio transcript** (what the model said, as text)
- `response.output_audio_transcript.delta`: `response_id`, `item_id`, `output_index`, `content_index`, `delta`.
- `response.output_audio_transcript.done`: same ids + full `transcript`. Also emitted when interrupted/cancelled/incomplete, so the transcript may be partial: it is text of what was *generated*, not what was *heard*.

**Output text** (text modality)
- `response.output_text.delta`: `response_id`, `item_id`, `output_index`, `content_index`, `delta`.
- `response.output_text.done`: same ids + full `text`.

**Output audio buffer (WebRTC/SIP only)**
- `output_audio_buffer.started`: `response_id`. Server began streaming audio.
- `output_audio_buffer.stopped`: `response_id`. Buffer fully drained, emitted *after* `response.done`. Use it, not `response.done`, to end the "assistant speaking" state.
- `output_audio_buffer.cleared`: `response_id`. VAD interruption or our `output_audio_buffer.clear`.
- `response.output_audio.delta` / `.done` exist but carry audio only on WebSocket. Ignore on WebRTC.

**Rate limits**
- `rate_limits.updated`: `rate_limits[]` of `{ name: "requests"|"tokens", limit, remaining, reset_seconds }`. Emitted at the start of a response; tokens are reserved for output then adjusted.

**Errors**
- `error`: `error.{type, code, message, param, event_id}`. `event_id` echoes the client event that caused it. Most errors are recoverable; the session stays open. Log, do not tear down by default.
- Doc example: `type:"invalid_request_error", code:"invalid_value"|"invalid_event"`.
- Billing/quota errors (HTTP-level, from the API error-codes guide; for the Realtime data channel they should arrive as `error` events or as a failed connect/secret request, **UNVERIFIED which**):
  | code | meaning |
  |---|---|
  | `credit_balance_exhausted` (429) | prepaid credits at zero |
  | `project_spend_limit_exceeded` (429) | project cap reached. **Most likely hit by the $20 cap** |
  | `organization_spend_limit_exceeded` (429) | org cap reached |
  | `organization_usage_limit_exceeded` (429) | OpenAI-assigned usage limit |
  | rate limit 429 / `slow_down` | honor `Retry-After`; do not retry billing errors |
  | `server_is_overloaded` (503) | retry after `Retry-After` |
  `error.type` may be `insufficient_quota` for billing errors: **branch on `error.code`, not type.** Retrying billing/spend errors never helps.

Source for codes: https://developers.openai.com/api/docs/guides/error-codes

## 4. Usage on response.done and pricing

```json
"usage": {
  "total_tokens": 253, "input_tokens": 132, "output_tokens": 121,
  "input_token_details": {
    "text_tokens": 119, "audio_tokens": 13, "image_tokens": 0,
    "cached_tokens": 64,
    "cached_tokens_details": { "text_tokens": 64, "audio_tokens": 0, "image_tokens": 0 }
  },
  "output_token_details": { "text_tokens": 30, "audio_tokens": 91 }
}
```
- `cached_tokens` are a **subset** of `input_tokens` (and `cached_tokens_details.*` a subset of the matching modality). Uncached = total modality tokens minus cached for that modality.
- Output has text and audio tokens only.

Prices, USD per 1M tokens (https://developers.openai.com/api/docs/pricing , fetched 2026-11-09):

| Model | Modality | Input | Cached input | Output |
|---|---|---|---|---|
| gpt-realtime-2.1 | audio | 32.00 | 0.40 | 64.00 |
| gpt-realtime-2.1 | text | 4.00 | 0.40 | 24.00 |
| gpt-realtime-2.1 | image | 5.00 | 0.50 | n/a |
| gpt-realtime-2.1-mini | audio | 10.00 | 0.30 | 20.00 |
| gpt-realtime-2.1-mini | text | 0.60 | 0.06 | 2.40 |
| gpt-realtime-2.1-mini | image | 0.80 | 0.08 | n/a |

Cost per response:
```
cost = Σ_modality [ (in_mod − cached_mod) × in_price + cached_mod × cached_price ] + Σ_modality out_mod × out_price   (÷ 1e6)
```
Token sizes: user audio = 1 token per 100 ms; assistant audio = 1 token per 50 ms (so spoken output is ~20 audio tokens/s, i.e. ~$0.0013/s on 2.1, ~$0.0004/s on mini). Counts include special tokens, so expect small drift.

Input transcription is billed separately, by its own model (section 6). Read it from the transcription `completed` event.

**Prompt caching:** automatic and best-effort, no opt-in. It matches the prefix of the input, so a stable history keeps hits high. Instructions and tool definitions sit at the start: **changing them mid-session busts the cache from the start.** Truncation drops the oldest items and also busts it; use `retention_ratio < 1` to truncate less often. The entire conversation is re-sent as input on every response, so later turns cost more. The big document in instructions is paid at the uncached text rate the first time and the cached rate after. That is the main cost lever for this app.

Sources: https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime

## 5. Limits

- Context window 128k tokens, max output 32k (model pages). Instructions count against context.
- **Max session length: 60 minutes.**
- Client secret TTL 10 to 7200 s, default 600 (section 1).
- Instruction size limit: **not documented** (UNVERIFIED). Enforce our own cap via the token-budget in `src/server/context`, and leave headroom for conversation history and output.
- Truncation: when input exceeds the context, oldest items drop (`truncation: "auto"`). With `"disabled"` the API errors instead.
- Rate limits: per-org requests and tokens, surfaced by `rate_limits.updated`.

## 6. Voices and transcription

Voices: `alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar`. OpenAI recommends **`marin` or `cedar`**. Locked after the first audio output.
Source: https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options

Input transcription models (`audio.input.transcription.model`) and price:
| model | price | notes |
|---|---|---|
| `gpt-transcribe` | $0.0045/min | cheapest current, **but WebSocket-only for committed-turn transcription in a Realtime session. Not usable on our WebRTC path** |
| `gpt-4o-mini-transcribe` | $0.003/min (also token-priced $1.25 in / $5 out per 1M) | cheapest that works with VAD over WebRTC. **Shutdown 2027-02-26** (recommended replacement: gpt-live-transcribe or gpt-transcribe) |
| `gpt-4o-transcribe` | $0.006/min | deprecated, shutdown 2027-02-26 |
| `whisper-1` | $0.006/min | deprecated, shutdown 2027-02-26 |
| `gpt-live-transcribe`, `gpt-realtime-whisper` | $0.017/min | require `turn_detection` omitted/null, so incompatible with our VAD conversation |

**Recommendation: `gpt-4o-mini-transcribe`.** It is fine for this project's lifetime (review window ends well before 2027-02-26) but note the sunset in the README. Transcription is optional; without it we lose user-side transcript text only. Assistant text still comes from `response.output_audio_transcript.*`.
Sources: https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/deprecations , https://developers.openai.com/api/docs/guides/realtime-transcription#transcribe-a-committed-turn

## 7. Beta vs GA names (never use the beta column)

The migration note confirms the GA names in the "GA" column marked ✓. Beta names are from the same guide's "beta to GA" section and the beta `RealtimeSessionCreateRequest` schema in the OpenAPI spec, except where marked (prior knowledge).

| Beta (do not use) | GA |
|---|---|
| header `OpenAI-Beta: realtime=v1` | remove it ✓ |
| `POST /v1/realtime/sessions` for ephemeral keys | `POST /v1/realtime/client_secrets` ✓ |
| `client_secret: { value, expires_at }` nested in response | top-level `value`, `expires_at`, plus `session` |
| `POST /v1/realtime?model=…` SDP exchange | `POST /v1/realtime/calls` ✓ |
| no `type` on session | `session.type: "realtime"` required ✓ |
| `modalities` | `output_modalities` (`["audio"]` or `["text"]`) |
| `voice` (top level) | `audio.output.voice` ✓ |
| `input_audio_format`, `output_audio_format` (strings like `pcm16`) | `audio.input.format` / `audio.output.format` = `{ type: "audio/pcm", rate: 24000 }` |
| `input_audio_transcription` | `audio.input.transcription` |
| `turn_detection` | `audio.input.turn_detection` |
| `speed` | `audio.output.speed` |
| `max_response_output_tokens` | `max_output_tokens` |
| `temperature` | removed in GA schema |
| `response.text.delta` / `.done` | `response.output_text.delta` / `.done` ✓ |
| `response.audio.delta` / `.done` | `response.output_audio.delta` / `.done` ✓ |
| `response.audio_transcript.delta` / `.done` | `response.output_audio_transcript.delta` / `.done` ✓ |
| `conversation.item.created` | `conversation.item.added` and `conversation.item.done` (`created` is still listed; do not rely on it) |
| `response.create` `modalities` | `output_modalities` (prior knowledge, verify) |

Source: https://developers.openai.com/api/docs/guides/realtime (Beta to GA migration), OpenAPI spec.
