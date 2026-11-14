import { MOCK_USAGE, type MockScript, type MockStep } from "./mock-transport";
import { ev, type Json } from "./wire-events";

// Named scripts for the mock transport. The e2e suite and the dev page pick
// one with ?mockRealtime=<name>. Times are in ms after session.created.

export {
  MOCK_SCENARIOS,
  isMockScenario,
  type MockScenarioName,
} from "./mock-names";
import type { MockScenarioName } from "./mock-names";

const step = (at: number, event: Json | string): MockStep => ({ at, event });

const CACHED_USAGE = {
  ...MOCK_USAGE,
  input_token_details: {
    ...MOCK_USAGE.input_token_details,
    cached_tokens: 480,
    cached_tokens_details: {
      text_tokens: 480,
      audio_tokens: 0,
      image_tokens: 0,
    },
  },
};

interface Speech {
  t: number;
  id: string;
  prev: string | null;
  /** When the final transcript lands, after the user stops talking. */
  transcribeAt: number;
  text: string | null;
  /** Stream partial words before the final text. Default true. */
  deltas?: boolean;
}

/** The user talks for 700 ms; their words are transcribed a bit later. */
function userSpeech(o: Speech): MockStep[] {
  const out = [
    step(o.t, ev.speechStarted(o.id)),
    step(o.t + 700, ev.speechStopped(o.id)),
    step(o.t + 720, ev.committed(o.id, o.prev)),
    step(o.t + 720, ev.userAdded(o.id, o.prev)),
  ];
  if (o.text === null) {
    out.push(step(o.transcribeAt, ev.transcriptionFailed(o.id)));
    return out;
  }
  const words = o.deltas === false ? [] : o.text.split(/(?<=\s)/);
  words.forEach((w, i) => {
    const at = o.t + 800 + i * 40;
    if (at < o.transcribeAt) out.push(step(at, ev.transcriptionDelta(o.id, w)));
  });
  out.push(
    step(
      o.transcribeAt,
      ev.transcriptionDone(o.id, o.text.trim(), {
        type: "duration",
        seconds: 2,
      }),
    ),
  );
  return out;
}

interface Answer {
  t: number;
  r: string;
  a: string;
  prev: string;
  words: string[];
  /** Stop after this many words (the rest never arrives: it was cut off). */
  only?: number;
  usage?: Json;
}

const WORD_MS = 220;

/** The assistant speaks word by word; audio starts shortly after the first words. */
function assistantAnswer(o: Answer): { steps: MockStep[]; end: number } {
  const words = o.only === undefined ? o.words : o.words.slice(0, o.only);
  const out: MockStep[] = [
    step(o.t, ev.responseCreated(o.r)),
    step(o.t + 30, ev.assistantAdded(o.a, o.prev)),
  ];
  let at = o.t + 200;
  out.push(step(at, ev.audioStarted(o.r)));
  for (const w of words) {
    out.push(step(at, ev.audioDelta(o.r, o.a, w)));
    at += WORD_MS;
  }
  if (o.only === undefined) {
    const full = o.words.join("");
    out.push(
      step(at, ev.audioTranscriptDone(o.r, o.a, full)),
      step(at, ev.assistantDone(o.a, o.prev, full)),
      step(
        at + 10,
        ev.responseDone(o.r, {
          outputIds: [o.a],
          usage: o.usage ?? MOCK_USAGE,
        }),
      ),
      step(at + 400, ev.audioStopped(o.r)),
    );
  }
  return { steps: out, end: at };
}

const ANSWER_1 = [
  "The ",
  "report ",
  "covers ",
  "revenue, ",
  "margins ",
  "and ",
  "the ",
  "outlook ",
  "for ",
  "next ",
  "year.",
];
const ANSWER_2 = ["Margins ", "were ", "forty ", "percent."];
const SHORT = ["Revenue ", "grew ", "twelve ", "percent ", "last ", "year."];

function normalTurn(opts: {
  transcribeAt: number;
  text: string | null;
  deltas?: boolean;
}): MockStep[] {
  return [
    ...userSpeech({
      t: 300,
      id: "u1",
      prev: null,
      transcribeAt: opts.transcribeAt,
      text: opts.text,
      deltas: opts.deltas,
    }),
    ...assistantAnswer({ t: 1100, r: "r1", a: "a1", prev: "u1", words: SHORT })
      .steps,
  ];
}

export function scenarioScript(name: MockScenarioName): MockScript {
  switch (name) {
    case "normal-turn":
      return {
        steps: normalTurn({ transcribeAt: 1000, text: "What was revenue? " }),
        replyWith: "audio",
      };

    case "late-transcription":
      // The reply is well under way before the user's words are known.
      return {
        steps: normalTurn({
          transcribeAt: 2000,
          text: "What was revenue? ",
          deltas: false,
        }),
        replyWith: "audio",
      };

    case "failed-transcription":
      return {
        steps: normalTurn({ transcribeAt: 1300, text: null }),
        replyWith: "audio",
      };

    case "barge-in": {
      const first = assistantAnswer({
        t: 1100,
        r: "r1",
        a: "a1",
        prev: "u1",
        words: ANSWER_1,
        only: 6,
      });
      const cut = first.end + 150;
      return {
        replyWith: "audio",
        steps: [
          ...userSpeech({
            t: 300,
            id: "u1",
            prev: null,
            transcribeAt: 1000,
            text: "Summarise this report. ",
          }),
          ...first.steps,
          // The user talks over the answer: the server cancels and clears it.
          step(cut, ev.speechStarted("u2")),
          step(
            cut + 20,
            ev.responseDone("r1", {
              status: "cancelled",
              reason: "turn_detected",
              outputIds: ["a1"],
              usage: MOCK_USAGE,
            }),
          ),
          step(cut + 30, ev.audioCleared("r1")),
          step(cut + 700, ev.speechStopped("u2")),
          step(cut + 720, ev.committed("u2", "a1")),
          step(cut + 720, ev.userAdded("u2", "a1")),
          step(
            cut + 1000,
            ev.transcriptionDone("u2", "Just the margins.", {
              type: "duration",
              seconds: 1,
            }),
          ),
          ...assistantAnswer({
            t: cut + 900,
            r: "r2",
            a: "a2",
            prev: "u2",
            words: ANSWER_2,
            usage: CACHED_USAGE,
          }).steps,
        ],
      };
    }

    case "text-turn":
      return {
        steps: [],
        replyWith: "text",
        textAnswer: "Revenue grew twelve percent last year.",
      };

    case "error":
      return {
        steps: [
          step(500, ev.error("invalid_value")),
          ...normalTurn({ transcribeAt: 1800, text: "What was revenue? " }).map(
            (s) => ({ ...s, at: s.at + 700 }),
          ),
        ],
        replyWith: "audio",
      };

    case "unknown-event":
      return {
        steps: [
          step(200, { type: "response.future_thing", payload: { a: 1 } }),
          step(250, "this is not json"),
          step(260, { type: "response.created" }),
          ...normalTurn({ transcribeAt: 1000, text: "What was revenue? " }),
        ],
        replyWith: "audio",
      };

    case "budget":
      return {
        steps: [
          step(
            800,
            ev.error(
              "project_spend_limit_exceeded",
              undefined,
              "insufficient_quota",
            ),
          ),
        ],
        replyWith: "audio",
      };

    default: {
      const unreachable: never = name;
      return unreachable;
    }
  }
}
