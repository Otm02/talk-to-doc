import { describe, expect, it } from "vitest";
import {
  connected,
  type Json,
  dispatch,
  ev,
  feed,
  play,
  transcript,
  visible,
} from "@test/realtime/script";
import { reducer } from "./reducer";
import { initialState, type Activity, type RealtimeState } from "./state";

const USAGE_1 = {
  total_tokens: 253,
  input_tokens: 132,
  output_tokens: 121,
  input_token_details: {
    text_tokens: 119,
    audio_tokens: 13,
    image_tokens: 0,
    cached_tokens: 64,
    cached_tokens_details: {
      text_tokens: 64,
      audio_tokens: 0,
      image_tokens: 0,
    },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 91 },
};

/** A voice turn up to the point the assistant is audibly answering. */
function midAnswer(): RealtimeState {
  return play(
    [
      ev.speechStarted("u1"),
      ev.speechStopped("u1"),
      ev.committed("u1", null),
      ev.userAdded("u1", null),
      ev.responseCreated("r1"),
      ev.assistantAdded("a1", "u1"),
      ev.transcriptionDone("u1", "What was revenue?"),
      ev.audioDelta("r1", "a1", "Revenue grew "),
      ev.audioStarted("r1"),
      ev.audioDelta("r1", "a1", "twelve percent "),
    ],
    connected(),
  );
}

/** Records `activity` after every event, to catch flicker between states. */
function trail(events: Json[], from: RealtimeState): Activity[] {
  const seen: Activity[] = [];
  let s = from;
  for (const e of events) {
    s = feed(s, e);
    seen.push(s.activity);
  }
  return seen;
}

describe("a normal voice turn", () => {
  it("walks the activity states and builds the transcript", () => {
    let s = connected();
    expect(s.activity).toBe("listening");

    s = play([ev.speechStarted("u1")], s);
    expect(s.activity).toBe("userSpeaking");
    s = play([ev.speechStopped("u1")], s);
    expect(s.activity).toBe("thinking");

    s = play([ev.committed("u1", null), ev.userAdded("u1", null)], s);
    expect(transcript(s)).toEqual([["user", "transcribing", ""]]);

    s = play([ev.responseCreated("r1"), ev.assistantAdded("a1", "u1")], s);
    expect(s.activity).toBe("thinking");
    expect(s.response.activeId).toBe("r1");

    s = play(
      [
        ev.transcriptionDelta("u1", "What was "),
        ev.transcriptionDelta("u1", "revenue?"),
      ],
      s,
    );
    expect(visible(s)[0]?.text).toBe("What was revenue?");
    s = play([ev.transcriptionDone("u1", "What was revenue?")], s);

    s = play(
      [ev.audioDelta("r1", "a1", "Revenue grew "), ev.audioStarted("r1")],
      s,
    );
    expect(s.activity).toBe("assistantSpeaking");
    s = play([ev.audioDelta("r1", "a1", "twelve percent.")], s);
    expect(transcript(s)).toEqual([
      ["user", "done", "What was revenue?"],
      ["assistant", "streaming", "Revenue grew twelve percent."],
    ]);

    s = play(
      [
        ev.audioTranscriptDone("r1", "a1", "Revenue grew twelve percent."),
        ev.assistantDone("a1", "u1", "Revenue grew twelve percent."),
        ev.responseDone("r1", { outputIds: ["a1"], usage: USAGE_1 }),
      ],
      s,
    );
    // response.done comes before the audio has finished playing.
    expect(s.activity).toBe("assistantSpeaking");
    expect(s.response).toEqual({ activeId: null, audioId: "r1" });
    expect(s.usage.responses).toBe(1);
    expect(visible(s)[1]?.status).toBe("done");

    s = play([ev.audioStopped("r1")], s);
    expect(s.activity).toBe("listening");
    expect(s.response).toEqual({ activeId: null, audioId: null });
  });

  it("goes back to listening after a response that produced no audio", () => {
    const s = play(
      [ev.responseCreated("r1"), ev.responseDone("r1", { outputIds: [] })],
      connected(),
    );
    expect(s.activity).toBe("listening");
  });
});

describe("barge-in", () => {
  it("marks the answer interrupted, keeps the words heard so far and freezes it", () => {
    let s = midAnswer();
    s = play([ev.speechStarted("u2")], s);

    expect(s.activity).toBe("userSpeaking");
    expect(transcript(s)).toEqual([
      ["user", "done", "What was revenue?"],
      ["assistant", "interrupted", "Revenue grew twelve percent "],
    ]);

    // Stragglers from the cancelled response must not change what was kept.
    s = play(
      [
        ev.audioDelta("r1", "a1", "and profit"),
        ev.audioTranscriptDone(
          "r1",
          "a1",
          "Revenue grew twelve percent and profit rose.",
        ),
        ev.assistantDone(
          "a1",
          "u1",
          "Revenue grew twelve percent and profit rose.",
        ),
        ev.responseDone("r1", {
          status: "cancelled",
          reason: "turn_detected",
          outputIds: ["a1"],
        }),
        ev.audioCleared("r1"),
      ],
      s,
    );
    expect(visible(s)[1]).toMatchObject({
      status: "interrupted",
      text: "Revenue grew twelve percent ",
    });
  });

  it("never flickers back to listening while the user is talking over it", () => {
    const seen = trail(
      [
        ev.speechStarted("u2"),
        ev.responseDone("r1", {
          status: "cancelled",
          reason: "turn_detected",
          outputIds: ["a1"],
        }),
        ev.audioCleared("r1"),
      ],
      midAnswer(),
    );
    expect(seen).toEqual(["userSpeaking", "userSpeaking", "userSpeaking"]);
  });

  it("does not let a late cleared undo the user's next turn", () => {
    const seen = trail(
      [
        ev.speechStarted("u2"),
        ev.speechStopped("u2"),
        ev.audioCleared("r1"),
        ev.responseDone("r1", { status: "cancelled", reason: "turn_detected" }),
      ],
      midAnswer(),
    );
    expect(seen).toEqual(["userSpeaking", "thinking", "thinking", "thinking"]);
  });

  it("interrupts an answer that finished generating but is still playing", () => {
    let s = play(
      [
        ev.audioTranscriptDone("r1", "a1", "Revenue grew twelve percent."),
        ev.assistantDone("a1", "u1", "Revenue grew twelve percent."),
        ev.responseDone("r1", { outputIds: ["a1"] }),
      ],
      midAnswer(),
    );
    expect(visible(s)[1]?.status).toBe("done");
    s = play([ev.speechStarted("u2")], s);
    expect(visible(s)[1]).toMatchObject({
      status: "interrupted",
      text: "Revenue grew twelve percent.",
    });
  });

  it("hides an answer interrupted before it said anything", () => {
    let s = play(
      [ev.responseCreated("r1"), ev.assistantAdded("a1", "u1")],
      connected(),
    );
    s = play([ev.speechStarted("u2")], s);
    expect(s.order).toEqual([]);
    // A straggling delta must not bring it back.
    s = play([ev.audioDelta("r1", "a1", "late")], s);
    expect(s.order).toEqual([]);
  });

  it("starts a fresh answer cleanly after the interruption", () => {
    const s = play(
      [
        ev.speechStarted("u2"),
        ev.speechStopped("u2"),
        ev.committed("u2", "a1"),
        ev.userAdded("u2", "a1"),
        ev.responseCreated("r2"),
        ev.assistantAdded("a2", "u2"),
        ev.audioDelta("r2", "a2", "Profit rose."),
        ev.audioStarted("r2"),
      ],
      midAnswer(),
    );
    expect(s.activity).toBe("assistantSpeaking");
    expect(transcript(s).map((r) => r[1])).toEqual([
      "done",
      "interrupted",
      "transcribing",
      "streaming",
    ]);
  });

  it("ignores audio that starts after the user began speaking", () => {
    const s = play(
      [ev.speechStarted("u1"), ev.audioStarted("r9")],
      connected(),
    );
    expect(s.activity).toBe("userSpeaking");
    expect(s.response.audioId).toBeNull();
  });

  it("records an interruption announced only through item.truncated", () => {
    const s = play(
      [
        {
          type: "conversation.item.truncated",
          item_id: "a1",
          content_index: 0,
          audio_end_ms: 900,
        },
      ],
      midAnswer(),
    );
    expect(visible(s)[1]?.status).toBe("interrupted");
  });
});

describe("audio buffer events", () => {
  it("ignores a stopped event for audio that is not the one playing", () => {
    const s = play([ev.audioStopped("r-other")], midAnswer());
    expect(s.activity).toBe("assistantSpeaking");
    expect(s.response.audioId).toBe("r1");
  });

  it("treats a lone cleared (no speech_started first) as an interruption", () => {
    const s = play([ev.audioCleared("r1")], midAnswer());
    expect(visible(s)[1]).toMatchObject({
      status: "interrupted",
      text: "Revenue grew twelve percent ",
    });
    expect(s.response.audioId).toBeNull();
    // The response is still generating, so the UI is "thinking", not "listening".
    expect(s.activity).toBe("thinking");
  });

  it("links an answer to its response when the item was announced first", () => {
    let s = play([ev.assistantAdded("a1", "u1")], connected());
    expect(s.items["a1"]?.responseId).toBeNull();
    s = play([ev.responseCreated("r1"), ev.assistantDone("a1", "u1", "Hi")], s);
    expect(s.items["a1"]?.responseId).toBe("r1");
  });

  it("takes the response id from response.done when nothing else gave it", () => {
    let s = play(
      [ev.assistantAdded("a1", "u1"), ev.audioDelta("r1", "a1", "Hel")],
      connected(),
    );
    s = {
      ...s,
      items: { ...s.items, a1: { ...s.items["a1"]!, responseId: null } },
    };
    s = play([ev.responseDone("r1", { outputIds: ["a1"] })], s);
    expect(s.items["a1"]?.responseId).toBe("r1");
    expect(s.items["a1"]?.status).toBe("done");
  });
});

describe("response.done outcomes", () => {
  it.each([
    ["cancelled", "client_cancelled"],
    ["cancelled", "turn_detected"],
    ["incomplete", "max_output_tokens"],
    ["incomplete", "content_filter"],
  ])(
    "marks the answer interrupted when status is %s (%s)",
    (status, reason) => {
      const s = play(
        [ev.responseDone("r1", { status, reason, outputIds: ["a1"] })],
        midAnswer(),
      );
      expect(visible(s)[1]).toMatchObject({
        status: "interrupted",
        text: "Revenue grew twelve percent ",
      });
      expect(s.response.activeId).toBeNull();
    },
  );

  it("marks a failed response interrupted, clears audioId, and returns to listening", () => {
    const s = play(
      [
        ev.responseDone("r1", {
          status: "failed",
          outputIds: ["a1"],
          error: { type: "server_error", code: "server_error", message: "x" },
        }),
      ],
      midAnswer(),
    );
    expect(visible(s)[1]?.status).toBe("interrupted");
    expect(s.notice).toEqual({ kind: "error", code: "server_error" });
    expect(s.response).toEqual({ activeId: null, audioId: null });
    expect(s.activity).toBe("listening");
    expect(s.connection.status).toBe("connected");
  });

  it("fills a missing answer text from the output item", () => {
    const s = play(
      [
        ev.responseCreated("r1"),
        ev.assistantAdded("a1", null),
        {
          type: "response.done",
          response: {
            id: "r1",
            status: "completed",
            output: [
              {
                id: "a1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_audio", transcript: "From output." }],
              },
            ],
          },
        },
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([["assistant", "done", "From output."]]);
  });

  it("sums usage over several responses, including cancelled ones", () => {
    const s = play(
      [
        ev.responseDone("r1", { usage: USAGE_1 }),
        ev.responseDone("r2", {
          status: "cancelled",
          reason: "turn_detected",
          usage: USAGE_1,
        }),
      ],
      connected(),
    );
    expect(s.usage.responses).toBe(2);
    expect(s.usage.input.text).toBe(238);
    expect(s.usage.cached.text).toBe(128);
    expect(s.usage.output.audio).toBe(182);
  });

  it("does not move activity for a response that is no longer current", () => {
    // r2 is the live response; a late done for r1 must not end it.
    const s = play(
      [
        ev.responseCreated("r2"),
        ev.responseDone("r1", { status: "cancelled", reason: "turn_detected" }),
      ],
      connected(),
    );
    expect(s.activity).toBe("thinking");
    expect(s.response.activeId).toBe("r2");
  });
});

describe("transcription ordering and failure", () => {
  it("keeps the user's words before the reply when transcription lands late", () => {
    let s = play(
      [
        ev.committed("u1", null),
        ev.userAdded("u1", null),
        ev.responseCreated("r1"),
        ev.assistantAdded("a1", "u1"),
        ev.audioDelta("r1", "a1", "Sure. "),
        ev.audioStarted("r1"),
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([
      ["user", "transcribing", ""],
      ["assistant", "streaming", "Sure. "],
    ]);
    s = play([ev.transcriptionDone("u1", "Tell me more.")], s);
    expect(transcript(s)).toEqual([
      ["user", "done", "Tell me more."],
      ["assistant", "streaming", "Sure. "],
    ]);
    expect(s.activity).toBe("assistantSpeaking");
  });

  it("orders correctly even when the assistant's events arrive before the user's item", () => {
    const s = play(
      [
        ev.audioDelta("r1", "a1", "Hello"),
        ev.transcriptionDone("u1", "Hi there"),
        ev.assistantAdded("a1", "u1"),
        ev.userAdded("u1", null),
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([
      ["user", "done", "Hi there"],
      ["assistant", "streaming", "Hello"],
    ]);
  });

  it("shows a transcribing placeholder for a transcription with no item yet", () => {
    const s = play([ev.transcriptionDelta("u1", "Hel")], connected());
    expect(transcript(s)).toEqual([["user", "transcribing", "Hel"]]);
  });

  it("marks a failed transcription and keeps the item in place", () => {
    let s = play(
      [
        ev.committed("u1", null),
        ev.userAdded("u1", null),
        ev.responseCreated("r1"),
        ev.assistantAdded("a1", "u1"),
        ev.transcriptionFailed("u1"),
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([
      ["user", "transcriptionFailed", ""],
      ["assistant", "streaming", ""],
    ]);
    // A late delta must not resurrect it.
    s = play([ev.transcriptionDelta("u1", "late")], s);
    expect(visible(s)[0]).toMatchObject({
      status: "transcriptionFailed",
      text: "",
    });
  });

  it("treats an empty transcript as a failure", () => {
    const s = play(
      [ev.userAdded("u1", null), ev.transcriptionDone("u1", "  \n")],
      connected(),
    );
    expect(visible(s)[0]?.status).toBe("transcriptionFailed");
  });

  it("trims the final transcript and records transcription usage", () => {
    const s = play(
      [
        ev.userAdded("u1", null),
        ev.transcriptionDone("u1", "Hello.\n", {
          type: "tokens",
          input_tokens: 40,
          output_tokens: 6,
        }),
        ev.transcriptionDone("u1", "Hello.", { type: "duration", seconds: 3 }),
      ],
      connected(),
    );
    expect(visible(s)[0]?.text).toBe("Hello.");
    expect(s.usage.transcription).toEqual({
      events: 2,
      inputTokens: 40,
      outputTokens: 6,
      seconds: 3,
    });
  });

  it("takes the transcript from item.done when it is already there", () => {
    const s = play(
      [
        ev.userAdded("u1", null),
        {
          type: "conversation.item.done",
          previous_item_id: null,
          item: {
            id: "u1",
            type: "message",
            role: "user",
            content: [{ type: "input_audio", transcript: "Quick one" }],
          },
        },
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([["user", "done", "Quick one"]]);
  });
});

describe("a text-mode turn", () => {
  const send = (s: RealtimeState, id: string, text: string, n: number) =>
    dispatch(s, {
      type: "local-text",
      id,
      text,
      createEventId: `evt_c${n}`,
      responseEventId: `evt_r${n}`,
    });

  it("shows an optimistic bubble and reconciles it by item id", () => {
    let s = send(connected("text"), "item_1", "What is this?", 1);
    expect(transcript(s)).toEqual([["user", "sending", "What is this?"]]);
    expect(s.activity).toBe("thinking");
    expect(Object.keys(s.pending).sort()).toEqual(["evt_c1", "evt_r1"]);

    s = play([ev.userTextAdded("item_1", "What is this?", null)], s);
    expect(transcript(s)).toEqual([["user", "done", "What is this?"]]);
    expect(s.pending).toEqual({ evt_r1: { kind: "response" } });

    s = play(
      [
        ev.responseCreated("r1"),
        ev.assistantAdded("a1", "item_1"),
        ev.textDelta("r1", "a1", "A "),
      ],
      s,
    );
    expect(s.activity).toBe("assistantSpeaking");
    s = play(
      [
        ev.textDelta("r1", "a1", "report."),
        ev.textDone("r1", "a1", "A report."),
        ev.assistantDone("a1", "item_1", "A report."),
        ev.responseDone("r1", { outputIds: ["a1"] }),
      ],
      s,
    );
    expect(transcript(s)).toEqual([
      ["user", "done", "What is this?"],
      ["assistant", "done", "A report."],
    ]);
    expect(s.activity).toBe("listening");
    expect(visible(s)[1]?.source).toBe("text");
  });

  it("orders a second text turn after the first reply", () => {
    let s = send(connected("text"), "item_1", "One?", 1);
    s = play(
      [
        ev.userTextAdded("item_1", "One?", null),
        ev.responseCreated("r1"),
        ev.assistantAdded("a1", "item_1"),
        ev.textDone("r1", "a1", "One."),
        ev.responseDone("r1", { outputIds: ["a1"] }),
      ],
      s,
    );
    s = send(s, "item_2", "Two?", 2);
    s = play([ev.userTextAdded("item_2", "Two?", "a1")], s);
    expect(transcript(s).map((r) => r[2])).toEqual(["One?", "One.", "Two?"]);
  });

  it("re-keys the bubble if the server assigns its own id to our text", () => {
    let s = send(connected("text"), "item_1", "Same words", 1);
    s = play([ev.userTextAdded("srv_9", "Same words", null)], s);
    expect(Object.keys(s.items)).toEqual(["srv_9"]);
    expect(transcript(s)).toEqual([["user", "done", "Same words"]]);
    expect(s.pending).toEqual({ evt_r1: { kind: "response" } });
  });

  it("flags the bubble as not sent when the server rejects the create", () => {
    let s = send(connected("text"), "item_1", "Hi", 1);
    s = play([ev.error("invalid_value", "evt_c1")], s);
    expect(transcript(s)).toEqual([["user", "sendFailed", "Hi"]]);
    expect(s.notice).toEqual({ kind: "error", code: "invalid_value" });
    expect(s.activity).toBe("listening");
    expect(s.connection.status).toBe("connected");
  });

  it("flags the bubble when the channel could not take the message", () => {
    let s = send(connected("text"), "item_1", "Hi", 1);
    s = dispatch(s, { type: "local-text-failed", id: "item_1" });
    expect(transcript(s)).toEqual([["user", "sendFailed", "Hi"]]);
    expect(s.activity).toBe("listening");
    expect(s.pending).toEqual({ evt_r1: { kind: "response" } });
    // A failed bubble can be dropped for a retry; others cannot.
    expect(
      dispatch(s, { type: "local-text-discard", id: "item_1" }).order,
    ).toEqual([]);
    const ok = send(connected("text"), "item_2", "Yo", 2);
    expect(dispatch(ok, { type: "local-text-discard", id: "item_2" })).toBe(ok);
    expect(dispatch(ok, { type: "local-text-failed", id: "nope" })).toBe(ok);
  });
});

describe("stop answer", () => {
  it("interrupts locally and ignores the cancelled echo", () => {
    let s = dispatch(midAnswer(), { type: "local-stop" });
    expect(visible(s)[1]).toMatchObject({
      status: "interrupted",
      text: "Revenue grew twelve percent ",
    });
    expect(s.activity).toBe("listening");
    expect(s.response).toEqual({ activeId: null, audioId: null });

    const seen = trail(
      [
        ev.responseDone("r1", {
          status: "cancelled",
          reason: "client_cancelled",
          outputIds: ["a1"],
        }),
        ev.audioCleared("r1"),
      ],
      s,
    );
    expect(seen).toEqual(["listening", "listening"]);
    s = play([ev.audioDelta("r1", "a1", "more")], s);
    expect(visible(s)[1]?.text).toBe("Revenue grew twelve percent ");
  });

  it("swallows the error for a cancel that raced with the end of the response", () => {
    let s = dispatch(connected(), { type: "benign", eventId: "evt_cancel" });
    s = play([ev.error("response_cancel_not_active", "evt_cancel")], s);
    expect(s.notice).toBeNull();
    expect(s.pending).toEqual({});
  });

  it("does nothing visible when there was nothing to stop", () => {
    const s = dispatch(connected(), { type: "local-stop" });
    expect(s.activity).toBe("listening");
    expect(s.order).toEqual([]);
  });
});

describe("error events", () => {
  it("keeps the session alive on a recoverable error", () => {
    const s = play([ev.error("invalid_value")], midAnswer());
    expect(s.notice).toEqual({ kind: "error", code: "invalid_value" });
    expect(s.connection.status).toBe("connected");
    expect(s.activity).toBe("assistantSpeaking");
  });

  it("falls back to the error type when there is no code", () => {
    const s = play(
      [{ type: "error", error: { type: "server_error", message: "x" } }],
      connected(),
    );
    expect(s.notice).toEqual({ kind: "error", code: "server_error" });
    const none = play([{ type: "error", error: {} }], connected());
    expect(none.notice).toEqual({ kind: "error", code: "unknown" });
  });

  it.each([
    "credit_balance_exhausted",
    "project_spend_limit_exceeded",
    "organization_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
  ])("treats %s as fatal and never as retryable", (code) => {
    const s = play([ev.error(code)], midAnswer());
    expect(s.connection).toEqual({
      status: "failed",
      code: "budget_exhausted",
    });
    // What was on screen stays, settled rather than left spinning.
    expect(transcript(s)[1]).toEqual([
      "assistant",
      "interrupted",
      "Revenue grew twelve percent ",
    ]);
    expect(s.activity).toBe("listening");
  });

  it("reads insufficient_quota from the error type too", () => {
    const s = play(
      [ev.error("some_code", undefined, "insufficient_quota")],
      connected(),
    );
    expect(s.connection.status).toBe("failed");
  });

  it("treats a billing error inside response.done as fatal", () => {
    const s = play(
      [
        ev.responseDone("r1", {
          status: "failed",
          error: {
            type: "insufficient_quota",
            code: "project_spend_limit_exceeded",
          },
        }),
      ],
      connected(),
    );
    expect(s.connection).toEqual({
      status: "failed",
      code: "budget_exhausted",
    });
  });
});

describe("unknown and malformed events", () => {
  it("counts them and leaves everything else alone", () => {
    const before = midAnswer();
    let s = play(
      [
        { type: "response.something_new", x: 1 },
        { type: "response.something_new" },
        { type: "another.one" },
        "not json",
        { type: "response.created" },
        { type: "rate_limits.updated", rate_limits: [] },
      ],
      before,
    );
    expect(s.diagnostics).toEqual({
      unknown: 3,
      malformed: 2,
      byType: { "response.something_new": 2, "another.one": 1 },
    });
    s = { ...s, diagnostics: before.diagnostics };
    expect(s).toEqual(before);
  });

  it("caps how many distinct unknown types it remembers", () => {
    let s = connected();
    for (let i = 0; i < 100; i++) {
      s = reducer(s, {
        type: "diagnostic",
        kind: "unknown",
        eventType: `t${i}`,
      });
    }
    expect(s.diagnostics.unknown).toBe(100);
    expect(Object.keys(s.diagnostics.byType)).toHaveLength(64);
    s = reducer(s, { type: "diagnostic", kind: "unknown", eventType: "t0" });
    expect(s.diagnostics.byType["t0"]).toBe(2);
    s = reducer(s, { type: "diagnostic", kind: "unknown" });
    expect(s.diagnostics.byType["(no type)"]).toBeUndefined();
  });
});

describe("connection", () => {
  const to = (s: RealtimeState, connection: RealtimeState["connection"]) =>
    reducer(s, { type: "connection", connection });

  it("runs idle → requestingMic → connecting → connected", () => {
    let s: RealtimeState = initialState;
    s = to(s, { status: "requestingMic" });
    s = to(s, { status: "connecting", phase: "minting" });
    s = to(s, { status: "connecting", phase: "negotiating" });
    expect(s.connection).toEqual({
      status: "connecting",
      phase: "negotiating",
    });
    s = to(s, { status: "connected" });
    expect(s.connection.status).toBe("connected");
  });

  it("refuses jumps that would be bugs", () => {
    expect(to(initialState, { status: "connected" })).toBe(initialState);
    expect(
      to(initialState, {
        status: "reconnecting",
        since: 1,
        phase: "grace",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(initialState);
    expect(to(initialState, { status: "failed", code: "internal" })).toBe(
      initialState,
    );
    expect(to(initialState, { status: "ended", reason: "user" })).toBe(
      initialState,
    );
    expect(to(initialState, { status: "idle" })).toBe(initialState);
  });

  it("enters and leaves reconnecting without losing the transcript", () => {
    let s = to(midAnswer(), {
      status: "reconnecting",
      since: 10,
      phase: "grace",
      attempt: 0,
      maxAttempts: 3,
    });
    expect(s.connection.status).toBe("reconnecting");
    expect(s.order).toHaveLength(2);
    s = to(s, { status: "connected" });
    expect(s.connection.status).toBe("connected");
    expect(s.activity).toBe("listening");
    expect(s.order).toHaveLength(2);
  });

  it("keeps the first terminal state: a later failure cannot overwrite an end", () => {
    const ended = to(midAnswer(), { status: "ended", reason: "max_duration" });
    expect(to(ended, { status: "failed", code: "internal" })).toBe(ended);
    expect(to(ended, { status: "ended", reason: "user" })).toBe(ended);
    const failed = to(midAnswer(), {
      status: "failed",
      code: "session_reconnect_failed",
    });
    expect(to(failed, { status: "ended", reason: "user" })).toBe(failed);
  });

  it("settles anything half-done when the session ends", () => {
    let s = play(
      [
        ev.userAdded("u9", null),
        ev.responseCreated("r1"),
        ev.assistantAdded("a9", "u9"),
        ev.audioDelta("r1", "a9", "Par"),
      ],
      connected("text"),
    );
    s = dispatch(s, {
      type: "local-text",
      id: "item_1",
      text: "x",
      createEventId: "c",
      responseEventId: "r",
    });
    s = to(s, { status: "ended", reason: "user" });
    expect(
      Object.fromEntries(Object.values(s.items).map((i) => [i.id, i.status])),
    ).toEqual({
      u9: "transcriptionFailed",
      a9: "interrupted",
      item_1: "sendFailed",
    });
    expect(s.pending).toEqual({});
    expect(s.response).toEqual({ activeId: null, audioId: null });
  });

  it("allows starting again after an end or a failure, then resets", () => {
    const ended = to(midAnswer(), { status: "ended", reason: "user" });
    expect(to(ended, { status: "requestingMic" }).connection.status).toBe(
      "requestingMic",
    );
    expect(
      to(ended, { status: "connecting", phase: "minting" }).connection.status,
    ).toBe("connecting");
    expect(to(ended, { status: "idle" }).connection.status).toBe("idle");
    // A new chat is a new chatSeq, so its timer starts over.
    expect(reducer(ended, { type: "reset" })).toEqual({
      ...initialState,
      chatSeq: ended.chatSeq + 1,
    });
  });

  it("starts a new epoch on every session.created", () => {
    let s = play([ev.userAdded("u1", null)], connected());
    expect(s.items["u1"]?.epoch).toBe(1);
    s = play([ev.sessionCreated(), ev.userAdded("u2", null)], s);
    expect(s.items["u2"]?.epoch).toBe(2);
    expect(s.order).toEqual(["u1", "u2"]);
  });
});

describe("beta events", () => {
  it("does not let a stray conversation.item.created add or move items", () => {
    const base = play([ev.userAdded("u1", null)], connected());
    const s = play(
      [
        { ...ev.userAdded("ghost", "u1"), type: "conversation.item.created" },
        { ...ev.assistantAdded("u1", null), type: "conversation.item.created" },
      ],
      base,
    );
    expect(s.items).toEqual(base.items);
    expect(s.diagnostics.unknown).toBe(0);
  });
});

describe("small actions", () => {
  it("sets mode with the mic issue, muted and notices", () => {
    let s = dispatch(initialState, {
      type: "mode",
      mode: "text",
      micIssue: "denied",
    });
    expect(s).toMatchObject({ mode: "text", micIssue: "denied" });
    s = dispatch(s, { type: "muted", muted: true });
    expect(s.muted).toBe(true);
    expect(dispatch(s, { type: "muted", muted: true })).toBe(s);
    s = dispatch(s, {
      type: "notice",
      notice: { kind: "cap_warning", secondsLeft: 60 },
    });
    expect(s.notice).toEqual({ kind: "cap_warning", secondsLeft: 60 });
    expect(dispatch(s, { type: "notice", notice: null }).notice).toBeNull();
  });

  it("ignores events about items it does not track and non-message items", () => {
    const s = play(
      [
        {
          type: "conversation.item.added",
          item: { id: "f1", type: "function_call" },
        },
        {
          type: "conversation.item.added",
          item: { id: "s1", type: "message", role: "system" },
        },
        { type: "conversation.item.truncated", item_id: "nope" },
        { type: "session.updated", session: {} },
      ],
      connected(),
    );
    expect(s.order).toEqual([]);
  });

  it("does not let a delta or transcript land on the wrong kind of item", () => {
    const s = play(
      [
        ev.userAdded("u1", null),
        ev.audioDelta("r1", "u1", "oops"),
        ev.audioTranscriptDone("r1", "u1", "oops"),
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([["user", "transcribing", ""]]);
  });

  it("lets the final answer text replace the streamed text", () => {
    const s = play(
      [
        ev.assistantAdded("a1", null),
        ev.audioDelta("r1", "a1", "Revenu"),
        ev.audioTranscriptDone("r1", "a1", "Revenue rose."),
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([
      ["assistant", "streaming", "Revenue rose."],
    ]);
  });

  it("treats item.done with status incomplete as an interrupted answer", () => {
    const s = play(
      [
        ev.assistantAdded("a1", null),
        ev.audioDelta("r1", "a1", "Half"),
        ev.assistantDone("a1", null, undefined, "incomplete"),
      ],
      connected(),
    );
    expect(transcript(s)).toEqual([["assistant", "interrupted", "Half"]]);
  });

  it("keeps a known link when item.done omits previous_item_id", () => {
    const s = play(
      [
        ev.userAdded("u1", null),
        ev.assistantAdded("a1", "u1"),
        {
          type: "conversation.item.done",
          item: {
            id: "a1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [],
          },
        },
      ],
      connected(),
    );
    expect(s.items["a1"]?.prev).toBe("u1");
  });

  it("treats a missing link on item.added as the first item", () => {
    const s = play(
      [
        {
          type: "conversation.item.added",
          item: {
            id: "u1",
            type: "message",
            role: "user",
            content: [{ type: "input_audio" }],
          },
        },
      ],
      connected(),
    );
    expect(s.items["u1"]?.prev).toBeNull();
  });
});

describe("retrying the microphone", () => {
  const textChat = (): RealtimeState =>
    reducer(connected(), { type: "mode", mode: "text", micIssue: "denied" });

  it("marks a retry as working and back, without churning identical states", () => {
    const working = reducer(textChat(), {
      type: "mic-retry",
      status: "working",
    });
    expect(working.micRetry).toBe("working");
    expect(reducer(working, { type: "mic-retry", status: "working" })).toBe(
      working,
    );
    expect(
      reducer(working, { type: "mic-retry", status: "idle" }).micRetry,
    ).toBe("idle");
  });

  it("a failed retry shows its reason, frees the button and is counted", () => {
    let s = reducer(textChat(), { type: "mic-retry", status: "working" });
    s = reducer(s, { type: "mic-retry-failed", reason: "in_use" });
    expect(s).toMatchObject({
      mode: "text",
      micIssue: "in_use",
      micRetry: "idle",
      micRetryFails: 1,
    });
    s = reducer(s, { type: "mic-retry-failed", reason: "denied" });
    expect(s).toMatchObject({ micIssue: "denied", micRetryFails: 2 });
    // The chat itself is untouched by any of it.
    expect(s.connection).toEqual({ status: "connected" });
  });

  it("a working mic clears the count; a new mic problem keeps it", () => {
    let s = reducer(textChat(), { type: "mic-retry-failed", reason: "denied" });
    s = reducer(s, { type: "mode", mode: "text", micIssue: "unavailable" });
    expect(s.micRetryFails).toBe(1);
    s = reducer(s, { type: "mode", mode: "voice", micIssue: null });
    expect(s).toMatchObject({
      mode: "voice",
      micIssue: null,
      micRetryFails: 0,
    });
  });

  it.each([
    { status: "ended", reason: "user" },
    { status: "failed", code: "session_reconnect_failed" },
  ] as const)(
    "a chat that is $status is no longer checking the mic",
    (connection) => {
      const working = reducer(textChat(), {
        type: "mic-retry",
        status: "working",
      });
      expect(
        reducer(working, { type: "connection", connection }).micRetry,
      ).toBe("idle");
    },
  );

  it("starts every chat with no retry in progress and none failed", () => {
    expect(initialState).toMatchObject({ micRetry: "idle", micRetryFails: 0 });
    const s = reducer(textChat(), {
      type: "mic-retry-failed",
      reason: "denied",
    });
    expect(reducer(s, { type: "reset" })).toEqual({
      ...initialState,
      chatSeq: s.chatSeq + 1,
    });
  });
});

describe("reconnecting", () => {
  const to = (s: RealtimeState, connection: RealtimeState["connection"]) =>
    reducer(s, { type: "connection", connection });
  const grace = {
    status: "reconnecting",
    since: 1,
    phase: "grace",
    attempt: 0,
    maxAttempts: 3,
  } as const;

  it("moves from one phase to the next without leaving 'reconnecting'", () => {
    let s = to(midAnswer(), grace);
    s = to(s, { ...grace, phase: "minting", attempt: 1 });
    expect(s.connection).toMatchObject({ phase: "minting", attempt: 1 });
    s = to(s, { ...grace, phase: "cooldown", attempt: 1, retryAt: 99 });
    expect(s.connection).toMatchObject({ phase: "cooldown", retryAt: 99 });
  });

  it("settles what was mid-flight on the dead session, and keeps the transcript", () => {
    const before = to(midAnswer(), grace);
    const after = reducer(before, { type: "reconnect-settle" });
    expect(after.connection.status).toBe("reconnecting");
    expect(after.response).toEqual({ activeId: null, audioId: null });
    expect(after.pending).toEqual({});
    expect(after.activity).toBe("listening");
    expect(after.order).toEqual(before.order);
    expect(
      Object.values(after.items).some((i) => i.status === "streaming"),
    ).toBe(false);
  });

  it("marks the epoch of a reconnected session once", () => {
    let s = play([ev.sessionCreated()], connected());
    s = reducer(s, { type: "reconnected" });
    s = reducer(s, { type: "reconnected" });
    expect(s.reconnectMarks).toEqual([s.epoch]);
  });

  it("keeps the marks and counts a new chat when the transcript is carried over", () => {
    let s = play([ev.sessionCreated()], connected());
    s = reducer(s, { type: "reconnected" });
    const next = reducer(s, { type: "restart" });
    expect(next.reconnectMarks).toEqual(s.reconnectMarks);
    expect(next.chatSeq).toBe(s.chatSeq + 1);
  });

  it("forgets the marks for a brand new chat", () => {
    let s = play([ev.sessionCreated()], connected());
    s = reducer(s, { type: "reconnected" });
    expect(reducer(s, { type: "reset" }).reconnectMarks).toEqual([]);
  });
});
