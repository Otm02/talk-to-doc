import { describe, expect, it } from "vitest";
import { ev } from "@test/realtime/script";
import { parseServerEvent } from "./events";

const parse = (o: object | string) =>
  parseServerEvent(typeof o === "string" ? o : JSON.stringify(o));

describe("parseServerEvent", () => {
  const handled: Array<[string, object]> = [
    ["session.created", ev.sessionCreated()],
    ["session.updated", { type: "session.updated", session: {} }],
    ["speech_started", ev.speechStarted("i1")],
    ["speech_stopped", ev.speechStopped("i1")],
    ["committed", ev.committed("i1", null)],
    ["item.added", ev.userAdded("i1", null)],
    ["item.done", ev.assistantDone("a1", "i1", "hi")],
    [
      "item.truncated",
      {
        type: "conversation.item.truncated",
        item_id: "a1",
        content_index: 0,
        audio_end_ms: 5,
      },
    ],
    ["transcription delta", ev.transcriptionDelta("i1", "he")],
    [
      "transcription completed (tokens)",
      ev.transcriptionDone("i1", "hello", {
        type: "tokens",
        input_tokens: 10,
        output_tokens: 3,
        input_token_details: { audio_tokens: 10 },
      }),
    ],
    [
      "transcription completed (duration)",
      ev.transcriptionDone("i1", "hello", { type: "duration", seconds: 2 }),
    ],
    ["transcription failed", ev.transcriptionFailed("i1")],
    ["response.created", ev.responseCreated("r1")],
    [
      "response.done",
      ev.responseDone("r1", { usage: { input_tokens: 5, output_tokens: 6 } }),
    ],
    ["audio transcript delta", ev.audioDelta("r1", "a1", "x")],
    ["audio transcript done", ev.audioTranscriptDone("r1", "a1", "x")],
    ["text delta", ev.textDelta("r1", "a1", "x")],
    ["text done", ev.textDone("r1", "a1", "x")],
    ["audio started", ev.audioStarted("r1")],
    ["audio stopped", ev.audioStopped("r1")],
    ["audio cleared", ev.audioCleared("r1")],
    ["error", ev.error("invalid_value", "evt_1")],
  ];

  it.each(handled)("parses %s", (_name, event) => {
    const result = parse(event);
    expect(result.kind).toBe("event");
  });

  it("keeps fields it does not declare, so new API fields never break it", () => {
    const result = parse({
      ...ev.responseCreated("r1"),
      brand_new_field: { a: 1 },
    });
    expect(result.kind).toBe("event");
  });

  it.each([
    "conversation.created",
    "conversation.item.created", // beta name: GA uses item.added / item.done
    "rate_limits.updated",
    "response.output_item.added",
    "response.output_item.done",
    "response.content_part.added",
    "response.content_part.done",
    "response.output_audio.delta",
    "response.output_audio.done",
    "input_audio_buffer.cleared",
    "input_audio_buffer.timeout_triggered",
    "conversation.item.deleted",
  ])("ignores the known-but-unused %s without counting it unknown", (type) => {
    expect(parse({ type })).toEqual({ kind: "ignored", type });
  });

  it("reports an unknown type with its name", () => {
    expect(parse({ type: "response.made_up", x: 1 })).toEqual({
      kind: "unknown",
      type: "response.made_up",
    });
  });

  it("never throws on junk", () => {
    for (const raw of [
      "",
      "not json",
      "null",
      "42",
      "[]",
      '"str"',
      "{}",
      '{"type":7}',
      '{"type":null}',
    ]) {
      expect(() => parse(raw)).not.toThrow();
      expect(parse(raw).kind).toBe("malformed");
    }
  });

  it("treats a known type with the wrong shape as malformed, keeping the type", () => {
    expect(parse({ type: "response.created", response: {} })).toEqual({
      kind: "malformed",
      type: "response.created",
    });
    expect(parse({ type: "output_audio_buffer.started" })).toEqual({
      kind: "malformed",
      type: "output_audio_buffer.started",
    });
    expect(
      parse({ type: "conversation.item.added", item: { role: "user" } }).kind,
    ).toBe("malformed");
  });

  it("accepts a null previous_item_id and an absent one", () => {
    expect(parse(ev.userAdded("i1", null)).kind).toBe("event");
    const { previous_item_id: _drop, ...without } = ev.userAdded("i1", null);
    void _drop;
    expect(parse(without).kind).toBe("event");
  });
});
