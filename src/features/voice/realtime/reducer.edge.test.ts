import { describe, expect, it } from "vitest";
import {
  connected,
  dispatch,
  ev,
  feed,
  play,
  transcript,
} from "@test/realtime/script";
import { reducer } from "./reducer";

// Edges the turn-by-turn tests in reducer.test.ts walk past: what a restart
// does to a half-finished chat, the cap on remembered requests, and events
// that name an item of the wrong kind (a server bug or a replay, never a
// reason to rewrite the transcript).

describe("restart (a replacement session in the same chat)", () => {
  it("settles whatever was mid-flight and keeps what was finished", () => {
    const s = play(
      [
        // A finished voice turn.
        ev.committed("u1", null),
        ev.userAdded("u1", null),
        ev.transcriptionDone("u1", "Hello"),
        ev.assistantAdded("a1", "u1"),
        ev.assistantDone("a1", "u1", "Hi there"),
        // A voice turn still being transcribed, and an answer still streaming.
        ev.committed("u2", "a1"),
        ev.userAdded("u2", "a1"),
        ev.responseCreated("r2"),
        ev.assistantAdded("a2", "u2"),
        ev.audioDelta("r2", "a2", "Half an ans"),
      ],
      connected(),
    );
    const typed = dispatch(s, {
      type: "local-text",
      id: "t1",
      text: "typed question",
      createEventId: "c1",
      responseEventId: "r1",
    });

    const after = reducer(typed, { type: "restart" });

    const byText = Object.fromEntries(
      transcript(after).map(([role, status, text]) => [text || role, status]),
    );
    expect(byText["Hello"]).toBe("done");
    expect(byText["Hi there"]).toBe("done");
    expect(byText["Half an ans"]).toBe("interrupted");
    expect(byText["typed question"]).toBe("sendFailed");
    expect(
      transcript(after).some(
        ([role, status]) => role === "user" && status === "transcriptionFailed",
      ),
    ).toBe(true);
    // A fresh session starts clean: nothing pending, nothing active.
    expect(after.pending).toEqual({});
    expect(after.response).toEqual({ activeId: null, audioId: null });
  });
});

describe("requests we are waiting to hear back about", () => {
  it("remembers only the most recent 24, dropping the oldest", () => {
    let s = connected();
    for (let i = 0; i < 30; i += 1) {
      s = reducer(s, { type: "benign", eventId: `evt_${i}` });
    }
    const keys = Object.keys(s.pending);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe("evt_6");
    expect(keys.at(-1)).toBe("evt_29");
  });
});

describe("events that name an item of the wrong kind", () => {
  it("never turn an assistant item into a user one, or the other way round", () => {
    let s = play([ev.assistantAdded("x1", null)], connected());
    const before = transcript(s);
    s = feed(s, ev.userAdded("x1", null));
    expect(transcript(s)).toEqual(before);

    s = play([ev.committed("u1", "x1"), ev.userAdded("u1", "x1")], s);
    const withUser = transcript(s);
    s = feed(s, ev.assistantAdded("u1", "x1"));
    expect(transcript(s)).toEqual(withUser);
  });

  it("ignores a transcription result for an assistant item", () => {
    let s = play([ev.assistantAdded("a1", null)], connected());
    const before = transcript(s);
    s = feed(s, ev.transcriptionDone("a1", "should not appear"));
    expect(transcript(s)).toEqual(before);
  });
});
