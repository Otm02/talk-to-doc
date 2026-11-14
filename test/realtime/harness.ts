import { expect, vi } from "vitest";
import type { MicFailure } from "@/features/voice/realtime/failure";
import { LevelMeter } from "@/features/voice/realtime/levels";
import { MintError } from "@/features/voice/realtime/mint";
import {
  MockTransport,
  type MockScript,
} from "@/features/voice/realtime/mock-transport";
import { EventRecorder } from "@/features/voice/realtime/recorder";
import {
  VoiceSession,
  type SessionDeps,
} from "@/features/voice/realtime/session";
import type { SessionResponse } from "@/lib/wire/session";
import {
  FakeAudioContext,
  FakeStream,
  asAudioContext,
  asStream,
  fakeAudioElement,
  fakeRaf,
} from "./fakes";

// Fake browser dependencies for the session controller, with every resource
// it hands out recorded so tests can prove it was all given back.

export interface HarnessOptions {
  /** How the mic prompt ends. "pending" never settles until resolveMic(). */
  mic?: "ok" | MicFailure | "pending";
  script?: MockScript;
  session?: Partial<SessionResponse>;
  /** Make mint() fail with this, or stay pending until resolveMint(). */
  mintError?: MintError | Error | "pending";
  /** Make createTransport() throw. */
  transportError?: Error;
  debug?: boolean;
  recorder?: boolean;
}

export function makeHarness(options: HarnessOptions = {}) {
  const frames = fakeRaf();
  const micStreams: FakeStream[] = [];
  const transports: MockTransport[] = [];
  const contexts: FakeAudioContext[] = [];
  const elements: ReturnType<typeof fakeAudioElement>[] = [];
  const removed: unknown[] = [];
  const meters: LevelMeter[] = [];
  const recorders: EventRecorder[] = [];

  let resolveMic: (v: { ok: true; stream: MediaStream }) => void = () => {};
  let resolveMint: (v: SessionResponse) => void = () => {};
  const visibility = { hidden: false, listeners: new Set<() => void>() };

  const response: SessionResponse = {
    clientSecret: "ek_test_not_a_real_secret",
    expiresAt: 1_800_000_000,
    model: "gpt-realtime-2.1-mini",
    maxSessionSeconds: 300,
    ...options.session,
  };

  const requestMic = vi.fn(async () => {
    if (options.mic === "pending") {
      return new Promise<{ ok: true; stream: MediaStream }>((resolve) => {
        resolveMic = resolve;
      });
    }
    if (options.mic && options.mic !== "ok") {
      return { ok: false as const, reason: options.mic };
    }
    const stream = new FakeStream();
    micStreams.push(stream);
    return { ok: true as const, stream: asStream(stream) };
  });

  const mint = vi.fn(async (_id: string, signal: AbortSignal) => {
    void signal;
    if (options.mintError === "pending") {
      return new Promise<SessionResponse>((resolve) => {
        resolveMint = resolve;
      });
    }
    if (options.mintError) throw options.mintError;
    return response;
  });

  const createTransport = vi.fn(async () => {
    if (options.transportError) throw options.transportError;
    const t = new MockTransport({
      connectDelayMs: 0,
      steps: [],
      ...options.script,
    });
    transports.push(t);
    return t;
  });

  const deps: SessionDeps = {
    mint,
    requestMic,
    createTransport,
    createAudioElement: vi.fn(() => {
      const el = fakeAudioElement();
      elements.push(el);
      return el;
    }),
    removeAudioElement: vi.fn((el) => {
      removed.push(el);
    }),
    createAudioContext: vi.fn(() => {
      const c = new FakeAudioContext();
      contexts.push(c);
      return asAudioContext(c);
    }),
    createLevelMeter: vi.fn((ctx) => {
      const m = new LevelMeter({
        audioContext: ctx,
        raf: frames.raf,
        caf: frames.caf,
      });
      meters.push(m);
      return m;
    }),
    createRecorder: vi.fn(() => {
      if (!options.recorder) return null;
      const r = new EventRecorder();
      recorders.push(r);
      return r;
    }),
    now: () => Date.now(),
    isDebug: () => options.debug ?? false,
    visibility: {
      isHidden: () => visibility.hidden,
      subscribe: (l) => {
        visibility.listeners.add(l);
        return () => visibility.listeners.delete(l);
      },
    },
  };

  const session = new VoiceSession("doc-1", deps);

  return {
    session,
    deps,
    mint,
    requestMic,
    createTransport,
    frames,
    micStreams,
    transports,
    contexts,
    elements,
    removed,
    meters,
    recorders,
    response,
    resolveMic: () => {
      const stream = new FakeStream();
      micStreams.push(stream);
      resolveMic({ ok: true, stream: asStream(stream) });
      return stream;
    },
    resolveMint: () => resolveMint(response),
    setHidden(hidden: boolean) {
      visibility.hidden = hidden;
      for (const l of [...visibility.listeners]) l();
    },
    get transport(): MockTransport {
      const t = transports.at(-1);
      if (!t) throw new Error("no transport created yet");
      return t;
    },
    /** Every resource handed out so far has been released. */
    expectAllReleased() {
      for (const s of micStreams) {
        for (const t of s.tracks) expect(t.readyState).toBe("ended");
      }
      for (const t of transports) expect(t.closeCount).toBe(1);
      for (const c of contexts) expect(c.closeCalls).toBe(1);
      expect(removed.length).toBe(elements.length);
      for (const m of meters) expect(m.running).toBe(false);
      expect(frames.pending).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;
