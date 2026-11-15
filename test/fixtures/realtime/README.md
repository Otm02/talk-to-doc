# Realtime event fixtures

JSONL recordings of real Realtime sessions, one event per line:
`{"t": <ms since the recorder started>, "dir": "in" | "out" | "meta", "data": <event>}`.

Record one with the dev tools on (`pnpm dev`, open the chat on a ready document, or add
`?debug=1` anywhere else), hold a short conversation, then press the download
button. The recorder redacts `instructions` (the document and the system
rules) and never keeps a client secret. Read the file before committing it.

`src/features/voice/realtime/golden.test.ts` replays every `*.jsonl` here
through the parser and the reducer, and `scriptFromRecording()` can play one
back through the mock transport.

## Fixtures

- `live-session-1.jsonl`: the event stream of a real voice chat of about 74 s on
  `gpt-realtime-2.1-mini`, recorded 2026-11-14 with the dev recorder. Five questions
  about a one-page PDF; the user talked over three of the answers (two while the audio
  was still playing, one while it was still being generated). It is the source of the
  measured cost ($0.038 for the session) and of the wire facts asserted in the golden
  test.

  **The text in it is synthetic.** The PDF was a personal document, so every transcript
  string (the user's questions and the model's answers, in streamed deltas and in
  done events) was replaced with made-up text about a generic design note, split into
  the same number of deltas as recorded. 11 delta events had also been merged earlier
  while names were being replaced (449 rows recorded, 438 here). Ids, timestamps, event
  order, audio markers and usage blocks are exactly as recorded. The unedited recording
  stays out of the repo, in the gitignored `.private/` folder.

## Recording a new one

Record on a public-domain or made-up document, not a personal one. The model speaks the
document back, so the transcripts can contain whatever the document says, and a word can
be split across streamed deltas, so check the reassembled text, not only the raw file.
Replacing a few names is not anonymising: the content itself can identify someone.
Read the whole file before committing it.
