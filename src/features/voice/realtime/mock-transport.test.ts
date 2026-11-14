import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connected, feed, transcript } from "@test/realtime/script";
import {
  cancelResponse,
  clearOutputAudio,
  createResponse,
  createTextItem,
} from "./client-events";
import {
  MOCK_SCENARIOS,
  isMockScenario,
  scenarioScript,
  type MockScenarioName,
} from "./mock-scenarios";
import { MockTransport, scriptFromRecording } from "./mock-transport";
import { parseServerEvent } from "./events";
import { EventRecorder } from "./recorder";
import type { RealtimeState } from "./state";
import { TransportError } from "./transport";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const types = (raw: string[]) =>
  raw.map((r) => {
    const v: unknown = JSON.parse(r);
    return typeof v === "object" && v !== null && "type" in v
      ? String(v.type)
      : "?";
  });

async function connect(t: MockTransport) {
  const p = t.connect({ clientSecret: "ek_x", micStream: null });
  await vi.advanceTimersByTimeAsync(200);
  await p;
}

describe("MockTransport", () => {
  it("emits session.created then plays steps at their offsets", async () => {
    const t = new MockTransport({
      connectDelayMs: 100,
      steps: [
        {
          at: 50,
          event: { type: "input_audio_buffer.speech_started", item_id: "u1" },
        },
        { at: 300, event: "raw text" },
      ],
    });
    const seen: string[] = [];
    const states: string[] = [];
    t.onEvent((r) => seen.push(r));
    t.onStateChange((s) => states.push(s));
    const p = t.connect({ clientSecret: "ek_x", micStream: null });
    await vi.advanceTimersByTimeAsync(99);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(types(seen)).toEqual(["session.created"]);
    expect(states).toEqual(["connecting", "connected"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(types(seen)).toEqual([
      "session.created",
      "input_audio_buffer.speech_started",
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen.at(-1)).toBe("raw text");
  });

  it("can fail to connect with a chosen kind", async () => {
    const t = new MockTransport({ steps: [], failWith: "busy" });
    const p = t.connect({ clientSecret: "ek_x", micStream: null });
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    const err = await caught;
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ kind: "busy" });
  });

  it("aborts connect on close and leaves no timers behind", async () => {
    const t = new MockTransport({ steps: [{ at: 5000, event: {} }] });
    const p = t.connect({ clientSecret: "ek_x", micStream: null });
    const caught = p.catch((e: unknown) => e);
    t.close();
    t.close();
    expect(await caught).toMatchObject({ kind: "aborted" });
    expect(t.closeCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      t.connect({ clientSecret: "ek_x", micStream: null }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("stops delivering after close, mid-script", async () => {
    const t = new MockTransport({
      steps: [{ at: 1000, event: { type: "x" } }],
    });
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    await connect(t);
    t.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(types(seen)).toEqual(["session.created"]);
  });

  it("remembers how it was connected and refuses a second connect", async () => {
    const t = new MockTransport({ steps: [] });
    await connect(t);
    expect(t.lastConnect).toEqual({ clientSecret: "ek_x", micStream: null });
    await expect(
      t.connect({ clientSecret: "ek_x", micStream: null }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("refuses to send until connected", () => {
    const t = new MockTransport({ steps: [] });
    expect(t.send(cancelResponse("e1"))).toBe(false);
    expect(t.sent).toEqual([]);
  });

  it("answers a typed message like the server: echo the item, then stream a text reply", async () => {
    const t = new MockTransport({ steps: [], textAnswer: "Two words." });
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    await connect(t);
    seen.length = 0;

    expect(t.send(createTextItem("item_1", "Hello?", "evt_c"))).toBe(true);
    expect(t.send(createResponse("evt_r", true))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    expect(types(seen)).toEqual([
      "conversation.item.added",
      "response.created",
      "conversation.item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "conversation.item.done",
      "response.done",
    ]);
    const echoed = JSON.parse(seen[0] ?? "{}");
    expect(echoed.item.id).toBe("item_1");
    expect(echoed.previous_item_id).toBeNull();
  });

  it("links a second turn to the previous answer", async () => {
    const t = new MockTransport({ steps: [] });
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    await connect(t);
    t.send(createTextItem("item_1", "One", "e1"));
    t.send(createResponse("e2", true));
    await vi.advanceTimersByTimeAsync(2000);
    seen.length = 0;
    t.send(createTextItem("item_2", "Two", "e3"));
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(seen[0] ?? "{}").previous_item_id).toBe("item_mock_a1");
  });

  it("streams audio when the script replies with audio and no text-only flag", async () => {
    const t = new MockTransport({
      steps: [],
      replyWith: "audio",
      textAnswer: "Hi.",
    });
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    await connect(t);
    seen.length = 0;
    t.send(createResponse("e1", false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(types(seen)).toContain("output_audio_buffer.started");
    expect(types(seen)).toContain("response.output_audio_transcript.delta");
    expect(types(seen).at(-1)).toBe("output_audio_buffer.stopped");
  });

  it("cancels an answer in flight: no more words, a cancelled response.done", async () => {
    const t = new MockTransport({
      steps: [],
      textAnswer: "one two three four five six",
    });
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    await connect(t);
    t.send(createTextItem("item_1", "go", "e1"));
    t.send(createResponse("e2", true));
    await vi.advanceTimersByTimeAsync(150);
    const wordsBefore = types(seen).filter(
      (x) => x === "response.output_text.delta",
    ).length;
    expect(wordsBefore).toBeGreaterThan(0);
    expect(wordsBefore).toBeLessThan(6);

    t.send(cancelResponse("e3"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      types(seen).filter((x) => x === "response.output_text.delta"),
    ).toHaveLength(wordsBefore);
    const done = JSON.parse(seen.at(-1) ?? "{}");
    expect(done.type).toBe("response.done");
    expect(done.response.status).toBe("cancelled");
    expect(done.response.status_details.reason).toBe("client_cancelled");
    expect(done.response.output[0].id).toBe("item_mock_a1");
  });

  it("answers a cancel with nothing in flight with an error naming the event", async () => {
    const t = new MockTransport({ steps: [] });
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    await connect(t);
    seen.length = 0;
    t.send(cancelResponse("evt_cancel"));
    await vi.advanceTimersByTimeAsync(50);
    expect(JSON.parse(seen[0] ?? "{}").error.event_id).toBe("evt_cancel");
  });

  it("clears audio only when audio is playing", async () => {
    const t = new MockTransport({
      steps: [],
      replyWith: "audio",
      textAnswer: "A long enough answer to be mid-stream.",
    });
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    await connect(t);
    t.send(clearOutputAudio("e0"));
    await vi.advanceTimersByTimeAsync(50);
    expect(types(seen)).not.toContain("output_audio_buffer.cleared");
    t.send(createResponse("e1", false));
    await vi.advanceTimersByTimeAsync(200);
    t.send(clearOutputAudio("e2"));
    await vi.advanceTimersByTimeAsync(50);
    expect(types(seen)).toContain("output_audio_buffer.cleared");
  });

  it("lets tests push events and change link state", async () => {
    const t = new MockTransport({ steps: [] });
    const seen: string[] = [];
    const states: string[] = [];
    t.onEvent((r) => seen.push(r));
    t.onStateChange((s) => states.push(s));
    await connect(t);
    t.push({ type: "x" });
    t.emitState("disconnected");
    t.emitState("disconnected");
    expect(seen.at(-1)).toBe('{"type":"x"}');
    expect(states.at(-1)).toBe("disconnected");
    expect(t.onRemoteStream()).toBeTypeOf("function");
  });

  it("runs faster with a speed factor", async () => {
    const t = new MockTransport(
      { connectDelayMs: 1000, steps: [{ at: 1000, event: { type: "x" } }] },
      { speed: 10 },
    );
    const seen: string[] = [];
    t.onEvent((r) => seen.push(r));
    const p = t.connect({ clientSecret: "ek_x", micStream: null });
    await vi.advanceTimersByTimeAsync(100);
    await p;
    await vi.advanceTimersByTimeAsync(100);
    expect(types(seen)).toEqual(["session.created", "x"]);
  });
});

describe("scriptFromRecording", () => {
  it("replays incoming events at their offset from session.created", () => {
    const rec = new EventRecorder(
      (() => {
        let t = 0;
        return () => (t += 100);
      })(),
    );
    rec.recordMeta({ note: "ignored" });
    rec.recordIn(JSON.stringify({ type: "session.created", session: {} }));
    rec.recordOut({ type: "response.cancel" });
    rec.recordIn(JSON.stringify({ type: "session.updated" }));
    rec.recordIn(
      JSON.stringify({
        type: "input_audio_buffer.speech_started",
        item_id: "u1",
      }),
    );
    rec.recordIn("garbage");
    const script = scriptFromRecording(rec.toJsonl(), { replyWith: "audio" });
    expect(script.replyWith).toBe("audio");
    expect(
      script.steps.map((s) => [s.at, (s.event as { type?: string }).type]),
    ).toEqual([
      [300, "input_audio_buffer.speech_started"],
      [400, undefined],
    ]);
  });

  it("works without a session.created and with parsed entries", () => {
    const script = scriptFromRecording([
      { t: 500, dir: "in", data: { type: "a" } },
      { t: 700, dir: "in", data: { type: "b" } },
      { t: 800, dir: "in", data: ["not", "a", "record"] },
    ]);
    expect(script.steps.map((s) => s.at)).toEqual([0, 200]);
    expect(scriptFromRecording([]).steps).toEqual([]);
  });
});

/** Plays a scenario through the mock + real parser + reducer. */
async function runScenario(name: MockScenarioName): Promise<RealtimeState> {
  const t = new MockTransport(scenarioScript(name));
  let s = connected();
  t.onEvent((raw) => (s = feed(s, raw)));
  const p = t.connect({ clientSecret: "ek_x", micStream: null });
  await vi.advanceTimersByTimeAsync(10_000);
  await p;
  t.close();
  return s;
}

describe("scenarios", () => {
  it("knows its own names", () => {
    expect(MOCK_SCENARIOS).toHaveLength(8);
    expect(isMockScenario("barge-in")).toBe(true);
    expect(isMockScenario("nope")).toBe(false);
    expect(isMockScenario(null)).toBe(false);
  });

  it("normal-turn: a question and a spoken answer", async () => {
    const s = await runScenario("normal-turn");
    expect(transcript(s)).toEqual([
      ["user", "done", "What was revenue?"],
      ["assistant", "done", "Revenue grew twelve percent last year."],
    ]);
    expect(s.activity).toBe("listening");
    expect(s.usage.responses).toBe(1);
  });

  it("late-transcription: the answer starts before the question is known", async () => {
    const s = await runScenario("late-transcription");
    expect(transcript(s)).toEqual([
      ["user", "done", "What was revenue?"],
      ["assistant", "done", "Revenue grew twelve percent last year."],
    ]);
  });

  it("failed-transcription: the question could not be transcribed", async () => {
    const s = await runScenario("failed-transcription");
    expect(transcript(s)[0]).toEqual(["user", "transcriptionFailed", ""]);
    expect(transcript(s)[1]?.[1]).toBe("done");
  });

  it("barge-in: the first answer is kept as heard and the second is complete", async () => {
    const s = await runScenario("barge-in");
    expect(transcript(s)).toEqual([
      ["user", "done", "Summarise this report."],
      ["assistant", "interrupted", "The report covers revenue, margins and "],
      ["user", "done", "Just the margins."],
      ["assistant", "done", "Margins were forty percent."],
    ]);
    expect(s.activity).toBe("listening");
    expect(s.usage.responses).toBe(2);
  });

  it("text-turn: has no scripted steps; replies come from the reaction", async () => {
    const s = await runScenario("text-turn");
    expect(s.order).toEqual([]);
    expect(scenarioScript("text-turn").textAnswer).toBe(
      "Revenue grew twelve percent last year.",
    );
  });

  it("error: a recoverable error does not stop the turn", async () => {
    const s = await runScenario("error");
    expect(s.notice).toEqual({ kind: "error", code: "invalid_value" });
    expect(s.connection.status).toBe("connected");
    expect(transcript(s)).toHaveLength(2);
  });

  it("unknown-event: unknown and malformed input is counted, the turn still works", async () => {
    const s = await runScenario("unknown-event");
    expect(s.diagnostics.unknown).toBe(1);
    expect(s.diagnostics.malformed).toBe(2);
    expect(transcript(s)).toHaveLength(2);
  });

  it("budget: a billing error is fatal", async () => {
    const s = await runScenario("budget");
    expect(s.connection).toEqual({
      status: "failed",
      code: "budget_exhausted",
    });
  });

  it.each([...MOCK_SCENARIOS])(
    "%s only contains events the parser understands",
    (name) => {
      for (const step of scenarioScript(name).steps) {
        expect(step.at).toBeGreaterThanOrEqual(0);
        if (name === "unknown-event") continue;
        const raw =
          typeof step.event === "string"
            ? step.event
            : JSON.stringify(step.event);
        expect(["event", "ignored"]).toContain(parseServerEvent(raw).kind);
      }
    },
  );
});
