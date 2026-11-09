# YouTube transcripts

Researched 2026-11-09. Two sources: `youtube-transcript-api` (Python, read from source at commit `6aadd42`, v1.2.5, 2026-11-05) for how YouTube behaves, and Supadata's REST API as the hosted fallback.

**Read this first:** the library's README states that "YouTube has started blocking most IPs that are known to belong to cloud providers (AWS, Google Cloud Platform, Azure, etc.)", and the same applies to Vercel. A direct fetch from a Vercel Function will probably fail with an IP block. Plan Supadata as the path that works in production, and the direct fetch as a best-effort first try or a local-dev path.
Source: https://github.com/jdepoix/youtube-transcript-api#working-around-ip-bans-requestblocked-or-ipblocked-exception

## 1. Direct fetch flow (youtube-transcript-api)

Files: `youtube_transcript_api/_transcripts.py`, `_settings.py`, `_api.py`, `_errors.py`. Source: https://github.com/jdepoix/youtube-transcript-api

Constants (`_settings.py`):
```
WATCH_URL         = https://www.youtube.com/watch?v={video_id}
INNERTUBE_API_URL = https://www.youtube.com/youtubei/v1/player?key={api_key}
INNERTUBE_CONTEXT = {"client": {"clientName": "ANDROID", "clientVersion": "20.10.38"}}
```
Session default header: `Accept-Language: en-US`. Plain `requests.Session`, no other custom headers, no cookies (cookie auth is disabled upstream, "not working with YouTube's most recent changes").

Steps:
1. **GET watch page** `WATCH_URL`. The body is HTML-unescaped.
   - If the HTML contains `action="https://consent.youtube.com/s"`, it is a cookie-consent wall. Read `name="v" value="(.*?)"`, set cookie `CONSENT=YES+<value>` on `.youtube.com`, re-fetch. Still a wall on the second try: `FailedToCreateConsentCookie`.
   - HTTP 429 on any request: `IpBlocked`. Any other HTTP error: `YouTubeRequestFailed`.
2. **Extract the InnerTube key** from the HTML with `"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"`.
   - No match and `class="g-recaptcha"` in the HTML: `IpBlocked`.
   - No match otherwise: `YouTubeDataUnparsable`.
3. **POST the player endpoint** `INNERTUBE_API_URL` with JSON `{"context": INNERTUBE_CONTEXT, "videoId": video_id}`. The library does not say why it uses the ANDROID client (likely because other clients now demand a PO token; unconfirmed). Expect the client name/version to need updating when YouTube changes.
4. **Check `playabilityStatus`** in the JSON (see section 3 for the mapping).
5. **Read caption tracks** at `captions.playerCaptionsTracklistRenderer`. Missing, or no `captionTracks` key: `TranscriptsDisabled`.
   - `captionTracks[]` fields used: `baseUrl`, `languageCode`, `name.runs[0].text`, `kind` (`"asr"` = auto-generated, absent = manual), `isTranslatable`.
   - `translationLanguages[]`: `languageCode`, `languageName.runs[0].text`.
6. **Pick a track.** Two dicts keyed by `languageCode`: manual and generated. `find_transcript(languages)` walks the caller's language list in priority order; for each language it checks **manual first, then generated**. No hit: `NoTranscriptFound`. Default language list is `("en",)`. Note the dict is keyed by language code, so two tracks with the same code (rare) collapse to the last one.
7. **GET the track URL** = `baseUrl` with `&fmt=srv3` removed (so YouTube returns the older plain XML, not srv3).
   - If the URL contains `&exp=xpe`: `PoTokenRequired` (no request is made).
   - Translation appends `&tlang=<code>` and is marked generated. Not needed for us.
8. **Parse the XML**: a root with `<text start="12.34" dur="2.5">line</text>` children. Per element: `html.unescape` the text, strip tags with `<[^>]*>` (the library can optionally keep `strong em b i mark small del ins sub sup`), `start` and `dur` are float seconds, `dur` defaults to `0.0`. Elements with no text are skipped. `dur` is on-screen time, so snippets can overlap. Parse with `defusedxml` equivalent in Node (do not use a vulnerable XML parser on untrusted input).

Node port notes: all of this is plain `fetch` + regex + a small XML parse. Only the watch-page HTML is unescaped (before the key regex); `baseUrl` comes from JSON and is used as-is.

## 2. Error semantics

| Situation | How the library detects it | Our `AppError` code (suggested) |
|---|---|---|
| IP block (cloud IP or too many requests) | HTTP 429, or watch HTML has `class="g-recaptcha"` with no API key, or step 3 returns `LOGIN_REQUIRED` with reason `Sign in to confirm you’re not a bot` (raised as `RequestBlocked`) | `youtube_blocked` (fall through to Supadata) |
| Bot check | `playabilityStatus.status == "LOGIN_REQUIRED"` and `reason == "Sign in to confirm you’re not a bot"` | same as above |
| Age restriction | `LOGIN_REQUIRED` and `reason == "This video may be inappropriate for some users."` (cannot be fetched without auth; cookie auth is unsupported upstream) | `youtube_age_restricted` |
| Unavailable / removed / private | `status == "ERROR"` and `reason == "This video is unavailable"` | `youtube_unavailable` |
| Other unplayable (region, members-only, live not started…) | any other non-`OK` status: `VideoUnplayable` with `reason` and `errorScreen.playerErrorMessageRenderer.subreason.runs[].text` | `youtube_unavailable` |
| Transcripts disabled | playable but no `captions.playerCaptionsTracklistRenderer.captionTracks` | `youtube_no_transcript` |
| Wanted language missing | `NoTranscriptFound` (the list of available tracks is on the error) | pick another track instead of failing |
| PO token needed | track URL has `&exp=xpe` | `youtube_blocked` |
| Consent wall not cleared | `FailedToCreateConsentCookie` | `youtube_blocked` |
| HTML/JSON shape changed | `YouTubeDataUnparsable` | `youtube_failed` |

The reason strings are matched **literally** (note the curly apostrophe in "you’re"). YouTube can change them at any time, so treat unknown non-OK statuses as `youtube_unavailable`, never as a crash, and never show the upstream reason text to the user (CLAUDE.md: no upstream messages to the client).

## 3. Supadata

Docs: https://docs.supadata.ai/youtube/get-transcript , errors: https://docs.supadata.ai/errors , pricing: https://supadata.ai/pricing

Request:
```
GET https://api.supadata.ai/v1/transcript?url=<urlencoded video url>&lang=en&text=true&mode=auto
x-api-key: <SUPADATA_API_KEY>
```
| param | notes |
|---|---|
| `url` | required. YouTube URL (also TikTok, Instagram, X, Facebook, or a public file URL). Encode it. |
| `lang` | optional ISO 639-1. Ignored when `mode=generate`. |
| `text` | `true` returns one plain string. Default `false` returns timed chunks. |
| `mode` | `native` (existing captions only), `generate` (AI transcription), `auto` (default: native, then generate). |
| `chunkSize` | max chars per chunk, only with `text=false`. |

Responses:
- **200, `text=true`:** `{ "content": "…", "lang": "en", "availableLangs": ["en","de"] }`
- **200, `text=false`:** `{ "content": [{ "text", "offset" /*ms*/, "duration" /*ms*/, "lang" }], "lang", "availableLangs" }`
- Empty `content` (`[]`) = processed but no speech; still billed by duration.
- If `lang` is unavailable the API returns the first available language and lists the rest in `availableLangs`. Check `lang` in the response, do not assume it matches the request.
- Prefer `text=true` for us (we only need the text). Use `text=false` only if we want timestamps.

**Async jobs (long videos):** videos over 20 minutes that need AI generation return **HTTP 202** with `{ "jobId": "…" }`. With `mode=generate` a request may start synchronously and switch to a job mid-flight, so always handle 202. Poll `GET https://api.supadata.ai/v1/transcript/{jobId}` (same header) about once per second. `status`: `queued | active | completed | failed` (`error` field on failed). Completed result has `content`, `lang`, `availableLangs`. Results expire **1 hour** after completion (then 404). Polling is free. Generated transcripts without a job can take ~100 s, so set the client timeout above that or avoid `generate`.

Error codes (JSON body `{ error, message, details, documentationUrl }`):
| `error` | HTTP | meaning |
|---|---|---|
| `invalid-request` | 400 | malformed request (also file too large/long) |
| `unauthorized` | 401 | bad API key |
| `upgrade-required` | 402 | feature not in plan |
| `forbidden` | 403 | video needs auth or is restricted |
| `not-found` | 404 | video missing or private (or expired job) |
| `limit-exceeded` | 429 | rate or quota limit |
| `transcript-unavailable` | **206** | no transcript exists (billed 1 credit) |
| `internal-error` | 500 | their bug |
| `upstream-error` | 502 | the target site returned an error |

**206 is a success-range status.** Check for it explicitly; do not rely on `res.ok`.

Limits and cost:
- Public videos only. Login-required, members-only, private, age-restricted and heavily geo-blocked videos fail. **Live streams are not supported.**
- Credits: native transcript = 1 credit; AI-generated = 2 credits per minute of video. `mode=native` is the cheap, predictable choice.
- **Free plan: 100 credits/month, 1 request/second, no credit card** (pricing page). That is about 100 native transcripts a month. Paid plans start at $5/month billed annually. Tier names and sizes on third-party sites disagree with the official page; trust the official page and re-check before relying on it. Whether free keys can use `generate` is not stated. Use `mode=native` and fall back gracefully.
- Rate limiting for our own handlers must keep us under 1 req/s to Supadata, and a per-IP limiter should protect the 100-credit monthly pool from abuse.

## 4. YouTube URL shapes to accept

Accepted hosts (exact match after lowercasing, no substring checks): `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtube-nocookie.com`, `www.youtube-nocookie.com`, `youtu.be`, `www.youtu.be`.

| Shape | Id location |
|---|---|
| `https://www.youtube.com/watch?v=ID` (+ any of `t`, `list`, `si`, `feature`, `pp`, `index`, in any order, `v` need not be first) | query `v` |
| `https://youtu.be/ID?si=…&t=10` | first path segment |
| `https://www.youtube.com/shorts/ID` | segment after `shorts` |
| `https://www.youtube.com/embed/ID` | segment after `embed` |
| `https://www.youtube.com/live/ID` | segment after `live` |
| `https://www.youtube.com/v/ID` (legacy) | segment after `v` |
| `https://m.youtube.com/watch?v=ID` | query `v` |
| `https://music.youtube.com/watch?v=ID` | query `v` |
| `https://www.youtube-nocookie.com/embed/ID` | segment after `embed` |
| `youtube.com/watch?v=ID` (no scheme) | tolerate by prepending `https://` |

**Video id rule:** exactly 11 characters from `[A-Za-z0-9_-]`. This is the de-facto format; YouTube does not publish it as a spec. Reject anything else, including ids with trailing characters. Playlist-only URLs, channel URLs and `@handle` URLs have no video id: reject with a clear message. `live/ID` works only for finished streams (Supadata does not do live).

Reference parser, tested against the shapes above plus negatives (short id, trailing junk, `evil.com`, `youtube.com.evil.com`, playlist URL, `javascript:`):
```ts
const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com","www.youtube.com","m.youtube.com","music.youtube.com",
  "youtube-nocookie.com","www.youtube-nocookie.com","youtu.be","www.youtu.be"]);

export function parseYouTubeId(input: string): string | null {
  const raw = input.trim();
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host.endsWith("youtu.be")) id = seg[0] ?? null;
  else if (seg[0] === "watch") id = u.searchParams.get("v");
  else if (seg[0] === "shorts" || seg[0] === "embed" || seg[0] === "live" || seg[0] === "v") id = seg[1] ?? null;
  return id !== null && ID.test(id) ? id : null;
}
```
After parsing, always rebuild the canonical `https://www.youtube.com/watch?v=<id>` before sending it to Supadata or YouTube. Never forward the user's raw URL (SSRF and parameter-injection guard).
Source for the library's id rule: `_api.py` docstring ("the actual ID, NOT the full URL").
