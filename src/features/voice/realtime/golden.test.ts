import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness } from "@test/realtime/harness";
import { connected, feed, replay, transcript } from "@test/realtime/script";
import { estimateCost } from "./cost";
import { parseServerEvent } from "./events";
import { scenarioScript } from "./mock-scenarios";
import { scriptFromRecording } from "./mock-transport";
import { parseJsonl, type RecordedEntry } from "./recorder";
import type { Activity } from "./state";

// Golden tests: real (or recorded) event streams replayed through the parser
// and the reducer. The recorder's output must be a faithful, replayable log,
// and the reducer must cope with what OpenAI actually sends.

const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../test/fixtures/realtime",
);

const load = (name: string): RecordedEntry[] =>
  parseJsonl(readFileSync(path.join(FIXTURES, name), "utf8"));

describe("recorded sessions replay faithfully", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a session recorded by the dev recorder replays to the same transcript", async () => {
    const h = makeHarness({
      recorder: true,
      script: scenarioScript("barge-in"),
    });
    h.session.start("voice");
    await vi.advanceTimersByTimeAsync(10_000);
    const live = h.session.getState();
    h.session.end();

    const recorded = parseJsonl(h.recorders[0]?.toJsonl() ?? "");
    const replayed = replay(recorded);
    expect(transcript(replayed)).toEqual(transcript(live));
    expect(transcript(replayed).map((r) => r[1])).toEqual([
      "done",
      "interrupted",
      "done",
      "done",
    ]);
    expect(replayed.usage).toEqual(live.usage);
    expect(replayed.activity).toBe(live.activity);
    expect(replayed.diagnostics).toEqual(live.diagnostics);
  });

  it("keeps the order of events, with times that never go backwards", async () => {
    const h = makeHarness({
      recorder: true,
      script: scenarioScript("normal-turn"),
    });
    h.session.start("voice");
    await vi.advanceTimersByTimeAsync(6000);
    h.session.end();
    const entries = parseJsonl(h.recorders[0]?.toJsonl() ?? "");
    const times = entries.map((e) => e.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(entries[0]).toMatchObject({
      dir: "meta",
      data: { event: "start" },
    });
  });
});

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"));

describe.each(files.length ? files : [null])("fixture %s", (file) => {
  if (file === null) {
    it("none recorded yet: see test/fixtures/realtime/README.md", () => {
      expect(readdirSync(FIXTURES)).toContain("README.md");
    });
    return;
  }
  const entries = load(file);
  const incoming = entries.filter((e) => e.dir === "in");

  it("never contains the document, the system rules or a client secret", () => {
    const text = JSON.stringify(entries);
    expect(text).not.toMatch(/ek_[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(text).not.toMatch(/"instructions":"(?!\[redacted)/);
  });

  it("parses end to end: every event is handled, ignored or counted, none is malformed", () => {
    const kinds = incoming.map(
      (e) => parseServerEvent(JSON.stringify(e.data)).kind,
    );
    expect(kinds.filter((k) => k === "malformed")).toEqual([]);
    expect(kinds).toContain("event");
  });

  it("replays to a settled state with a readable transcript", () => {
    const s = replay(entries);
    expect(s.connection.status).toBe("connected");
    expect(s.diagnostics.malformed).toBe(0);
    expect(s.order.length).toBeGreaterThan(0);
    for (const row of transcript(s)) {
      expect(["transcribing"]).not.toContain(row[1]);
    }
  });
});

// ---------------------------------------------------------------------------
// live-session-1.jsonl: the event stream of a real ~74 s voice chat on
// gpt-realtime-2.1-mini, recorded on 2026-11-14 with the dev recorder: five
// questions about a one-page PDF, three of them cut off by the user talking
// over the answer. The PDF was a personal document, so every transcript string
// (user questions and assistant answers, in deltas and in done events) was
// replaced with synthetic text about a generic design note, re-split into the
// same number of deltas. Earlier, 11 delta events were merged while names were
// being replaced (449 rows recorded, 438 here). Ids, timestamps, event order,
// audio markers and usage blocks are exactly as recorded. The text-dependent
// assertions below are therefore about the synthetic text; the shape and the
// numbers are real.

const LIVE = "live-session-1.jsonl";

describe("live-session-1: a real chat with three barge-ins", () => {
  const entries = load(LIVE);
  const state = replay(entries);
  const rows = transcript(state);

  const QUESTIONS = [
    "What is the main topic of this document?",
    "Do you know when the document was written?",
    "Can you summarize the details on page 1?",
    "What about page 2?",
    "Thanks.",
  ];

  /** What the model said for each response, as the stream's own .done events give it. */
  const finalAnswers = entries
    .map((e) => e.data)
    .flatMap((d) =>
      typeof d === "object" &&
      d !== null &&
      "type" in d &&
      d.type === "response.output_audio_transcript.done" &&
      "transcript" in d &&
      typeof d.transcript === "string"
        ? [d.transcript]
        : [],
    );

  it("lists five questions and five answers, alternating, in conversation order", () => {
    expect(rows.map((r) => r[0])).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(rows.filter((r) => r[0] === "user").map((r) => r[2])).toEqual(
      QUESTIONS,
    );
  });

  it("transcribes every question even though transcription lands after the answer has begun", () => {
    // In the recording, response.created precedes the first transcript by ~500 ms.
    const created = entries.findIndex(
      (e) =>
        typeof e.data === "object" &&
        e.data !== null &&
        "type" in e.data &&
        e.data.type === "response.created",
    );
    const firstTranscript = entries.findIndex(
      (e) =>
        typeof e.data === "object" &&
        e.data !== null &&
        "type" in e.data &&
        e.data.type === "conversation.item.input_audio_transcription.completed",
    );
    expect(created).toBeLessThan(firstTranscript);
    expect(rows.filter((r) => r[0] === "user").map((r) => r[1])).toEqual(
      Array(5).fill("done"),
    );
  });

  it("marks exactly the answers the user talked over as interrupted", () => {
    expect(rows.filter((r) => r[0] === "assistant").map((r) => r[1])).toEqual([
      "done", // played to the end
      "interrupted", // finished generating, cut off while still playing
      "interrupted", // cancelled mid-generation (turn_detected)
      "interrupted", // finished generating, cut off while still playing
      "done", // played to the end
    ]);
  });

  it("keeps what was generated for an interrupted answer, which is more than was heard", () => {
    // Known limit, measured here: the stream carries no heard-so-far text.
    // For the third answer the model generated 33 s of audio (660 audio
    // tokens at 50 ms each) and the user heard 3.3 s of it
    // (conversation.item.truncated audio_end_ms). The reducer keeps the
    // generated text, frozen at the moment of the interruption. The text is
    // synthetic (see above) and 660 characters long, about the size of the
    // recorded answer (616 characters).
    const answers = rows.filter((r) => r[0] === "assistant").map((r) => r[2]);
    expect(answers).toEqual(finalAnswers);
    expect(answers[2]).toHaveLength(660);
  });

  it("settles to listening when the chat is over", () => {
    expect(state.activity).toBe("listening");
    expect(state.response).toEqual({ activeId: null, audioId: null });
    expect(state.connection.status).toBe("connected");
    expect(state.notice).toBeNull();
    expect(state.diagnostics).toEqual({ unknown: 0, malformed: 0, byType: {} });
  });

  it("never shows 'listening' between a barge-in and the next answer", () => {
    // A consistency check on real data. In this recording the old answer's
    // done / cleared / truncated events all land before the user stops
    // talking, so it does not reproduce the late-event race itself; that is
    // pinned down in reducer.test.ts ("does not let a late cleared undo...").
    let s = connected();
    let inTurn = false;
    const seen: Activity[] = [];
    for (const e of entries.filter((x) => x.dir === "in")) {
      const type =
        typeof e.data === "object" && e.data !== null && "type" in e.data
          ? e.data.type
          : undefined;
      if (type === "session.created") continue;
      s = feed(s, JSON.stringify(e.data));
      if (type === "input_audio_buffer.speech_started") inTurn = true;
      if (type === "response.created") inTurn = false;
      if (inTurn) seen.push(s.activity);
    }
    expect(seen.length).toBeGreaterThan(10);
    expect(seen).not.toContain("listening");
  });

  it("sums the real usage blocks (hand-checked against the recording)", () => {
    expect(state.usage.responses).toBe(5);
    expect(state.usage.input).toEqual({ text: 4695, audio: 340, image: 0 });
    expect(state.usage.cached).toEqual({ text: 3456, audio: 128, image: 0 });
    // reasoning_tokens are part of text_tokens, so text + audio is the whole output.
    expect(state.usage.output).toEqual({ text: 604, audio: 1669 });
    expect(state.usage.transcription).toEqual({
      events: 5,
      inputTokens: 102,
      outputTokens: 46,
      seconds: 0,
    });
  });

  it("prices the session on mini (hand-priced: $0.03794 responses + $0.00036 transcription)", () => {
    // text in 1239 x 0.60 + cached 3456 x 0.06 + audio in 212 x 10 + cached 128 x 0.30
    //   + text out 604 x 2.40 + audio out 1669 x 20 = 37,938.76 per 1M
    // transcription 102 x 1.25 + 46 x 5 = 357.5 per 1M
    const cost = estimateCost("gpt-realtime-2.1-mini", state.usage);
    expect(cost?.usd).toBeCloseTo(0.03829626, 8);
    expect(cost?.tokens).toBe(7456);
    expect(cost?.lines.map((l) => [l.label, l.tokens])).toEqual([
      ["text in", 1239],
      ["text in (cached)", 3456],
      ["audio in", 212],
      ["audio in (cached)", 128],
      ["text out", 604],
      ["audio out", 1669],
      ["transcription", 148],
    ]);
  });

  describe("what OpenAI really sends, which the reducer relies on", () => {
    const events = entries
      .filter((e) => e.dir === "in")
      .map((e) => ({
        t: e.t,
        data: e.data as Record<string, unknown> & { type: string },
      }));
    const at = (type: string) => events.filter((e) => e.data.type === type);

    it("announces a barge-in with speech_started before the audio is cleared", () => {
      const cleared = at("output_audio_buffer.cleared");
      expect(cleared).toHaveLength(3);
      for (const c of cleared) {
        const started = [...at("input_audio_buffer.speech_started")]
          .reverse()
          .find((s) => s.t <= c.t);
        expect(started, "speech_started before cleared").toBeDefined();
        expect(c.t - (started?.t ?? 0)).toBeLessThan(200);
      }
    });

    it("truncates each cut-off item and says how much audio was played", () => {
      const truncated = at("conversation.item.truncated");
      expect(truncated).toHaveLength(3);
      expect(truncated.map((e) => e.data["audio_end_ms"])).toEqual([
        2860, 3340, 7640,
      ]);
    });

    it("ends an answer cancelled by the user's voice with turn_detected", () => {
      const cancelled = at("response.done").filter(
        (e) =>
          (e.data["response"] as { status: string }).status === "cancelled",
      );
      expect(cancelled).toHaveLength(1);
      const response = cancelled[0]?.data["response"] as {
        status_details: unknown;
      };
      expect(response.status_details).toEqual({
        type: "cancelled",
        reason: "turn_detected",
      });
    });

    it("finishes an interrupted item with status incomplete", () => {
      const incomplete = at("conversation.item.done").filter(
        (e) => (e.data["item"] as { status?: string }).status === "incomplete",
      );
      expect(incomplete).toHaveLength(1);
    });

    it("sends the model's audio-start and stop markers around every spoken answer", () => {
      expect(at("output_audio_buffer.started")).toHaveLength(5);
      // Only the answers played to the end get a stopped marker.
      expect(at("output_audio_buffer.stopped")).toHaveLength(2);
    });
  });

  describe("played back through the session controller", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("the mock transport replays the recording to the same transcript, usage and cost", async () => {
      const h = makeHarness({
        script: scriptFromRecording(entries, { replyWith: "audio" }),
        session: { maxSessionSeconds: 600 },
      });
      h.session.start("voice");
      await vi.advanceTimersByTimeAsync(80_000);

      const s = h.session.getState();
      expect(transcript(s)).toEqual(rows);
      expect(s.usage).toEqual(state.usage);
      expect(s.activity).toBe("listening");
      expect(s.connection.status).toBe("connected");
      expect(estimateCost(h.session.model ?? "", s.usage)?.usd).toBeCloseTo(
        0.03829626,
        8,
      );
      h.session.end();
      h.expectAllReleased();
    });
  });
});
