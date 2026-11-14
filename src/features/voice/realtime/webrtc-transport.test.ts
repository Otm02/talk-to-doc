import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakePeerConnection,
  FakeStream,
  FakeTrack,
  asPc,
  asStream,
  fakeAudioElement,
  sdpFetch,
} from "@test/realtime/fakes";
import { cancelResponse } from "./client-events";
import { TransportError, type TransportState } from "./transport";
import {
  CALLS_URL,
  CONNECT_TIMEOUT_MS,
  DATA_CHANNEL_LABEL,
  WebRtcTransport,
} from "./webrtc-transport";

const SECRET = "ek_test_not_a_real_secret";
const CREATED = JSON.stringify({ type: "session.created", session: {} });

async function settle() {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
}

function setup(fetchImpl = sdpFetch()) {
  const audio = fakeAudioElement();
  const transport = new WebRtcTransport({
    audioElement: audio,
    createPeerConnection: () => asPc(new FakePeerConnection()),
    fetch: fetchImpl as unknown as typeof fetch,
  });
  const states: TransportState[] = [];
  transport.onStateChange((s) => states.push(s));
  const pc = () => {
    const p = FakePeerConnection.instances[0];
    if (!p) throw new Error("no peer connection yet");
    return p;
  };
  const channel = () => {
    const c = pc().channel;
    if (!c) throw new Error("no data channel yet");
    return c;
  };
  return { transport, audio, states, pc, channel, fetchImpl };
}

/** Starts connect and captures how it settles without leaking rejections. */
function start(t: WebRtcTransport, micStream: MediaStream | null = null) {
  const outcome = { value: "pending" as "pending" | "ok" | TransportError };
  const promise = t.connect({ clientSecret: SECRET, micStream }).then(
    () => {
      outcome.value = "ok";
    },
    (e: unknown) => {
      outcome.value =
        e instanceof TransportError ? e : new TransportError("network");
    },
  );
  return { outcome, promise };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeerConnection.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connecting", () => {
  it("creates the data channel before the offer and posts the SDP with the secret", async () => {
    const mic = new FakeStream();
    const { transport, pc, channel, fetchImpl } = setup();
    const { outcome } = start(transport, asStream(mic));
    await settle();

    expect(pc().log).toEqual([
      "addTrack",
      "createDataChannel",
      "createOffer",
      "setLocalDescription",
      "setRemoteDescription",
    ]);
    expect(channel().label).toBe(DATA_CHANNEL_LABEL);
    expect(pc().tracksAdded).toEqual([[mic.tracks[0], mic]]);
    expect(pc().transceivers).toEqual([]);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CALLS_URL);
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(init).toMatchObject({
      method: "POST",
      body: "v=0 fake-offer",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/sdp",
      },
    });
    expect(pc().remoteDescription).toEqual({
      type: "answer",
      sdp: "v=0 fake-answer",
    });
    expect(outcome.value).toBe("pending");
  });

  it("sends a receive-only audio line instead of a mic in text mode", async () => {
    const { transport, pc } = setup();
    start(transport, null);
    await settle();
    expect(pc().tracksAdded).toEqual([]);
    expect(pc().transceivers).toEqual([
      { kind: "audio", init: { direction: "recvonly" } },
    ]);
  });

  it("is connected only after the channel is open AND session.created arrived", async () => {
    const { transport, channel, states } = setup();
    const { outcome } = start(transport);
    await settle();

    channel().open();
    await settle();
    expect(outcome.value).toBe("pending");
    expect(states).toEqual(["connecting"]);

    channel().message(CREATED);
    await settle();
    expect(outcome.value).toBe("ok");
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("also connects when session.created beats the channel's open event", async () => {
    const { transport, channel } = setup();
    const { outcome } = start(transport);
    await settle();
    channel().message(CREATED);
    await settle();
    expect(outcome.value).toBe("pending");
    channel().open();
    await settle();
    expect(outcome.value).toBe("ok");
  });

  it("hands session.created to listeners before connect resolves", async () => {
    const { transport, channel } = setup();
    const order: string[] = [];
    transport.onEvent((raw) =>
      order.push(raw === CREATED ? "event:session.created" : "event:other"),
    );
    const { promise } = start(transport);
    void promise.then(() => order.push("resolved"));
    await settle();
    channel().open();
    channel().message("not json at all");
    channel().message(CREATED);
    await settle();
    expect(order.at(-2)).toBe("event:session.created");
    expect(order.at(-1)).toBe("resolved");
  });

  it("passes raw messages on and ignores non-text frames", async () => {
    const { transport, channel } = setup();
    const seen: string[] = [];
    const off = transport.onEvent((raw) => seen.push(raw));
    start(transport);
    await settle();
    channel().open();
    channel().message(CREATED);
    channel().message(new ArrayBuffer(4));
    channel().message('{"type":"x"}');
    off();
    channel().message('{"type":"after-off"}');
    expect(seen).toEqual([CREATED, '{"type":"x"}']);
  });

  it("plays the remote audio and tells listeners about the stream", async () => {
    const { transport, pc, audio } = setup();
    const streams: unknown[] = [];
    transport.onRemoteStream((s) => streams.push(s));
    start(transport);
    await settle();
    const remote = new FakeStream();
    pc().fireTrack(remote);
    expect(audio.srcObject).toBe(remote);
    expect(audio.play).toHaveBeenCalled();
    expect(streams).toEqual([remote]);
  });

  it("wraps a bare track in a stream when the browser sends none", async () => {
    class FakeMediaStream {
      constructor(readonly tracks: unknown[]) {}
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const { transport, pc, audio } = setup();
    start(transport);
    await settle();
    const track = new FakeTrack();
    pc().fireTrack(null, track);
    expect(audio.srcObject).toBeInstanceOf(FakeMediaStream);
    expect((audio.srcObject as unknown as FakeMediaStream).tracks).toEqual([
      track,
    ]);
  });

  it("is single use", async () => {
    const { transport } = setup();
    start(transport);
    await settle();
    await expect(
      transport.connect({ clientSecret: SECRET, micStream: null }),
    ).rejects.toMatchObject({
      kind: "aborted",
    });
  });
});

describe("failing to connect", () => {
  async function failWith(res: Response) {
    const s = setup(sdpFetch(() => res));
    const { outcome } = start(s.transport);
    await settle();
    return { ...s, outcome };
  }

  it.each([
    [401, "rejected"],
    [400, "rejected"],
    [403, "rejected"],
    [429, "busy"],
    [500, "busy"],
    [503, "busy"],
  ])(
    "maps SDP status %i to %s and releases everything",
    async (status, kind) => {
      const { outcome, pc, channel, audio, states } = await failWith(
        new Response("nope", { status }),
      );
      expect(outcome.value).toMatchObject({ kind, status });
      expect(pc().closeCalls).toBe(1);
      expect(channel().closeCalls).toBe(1);
      expect(audio.srcObject).toBeNull();
      expect(states).toEqual(["connecting", "failed"]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [
      "project_spend_limit_exceeded",
      JSON.stringify({ error: { code: "project_spend_limit_exceeded" } }),
    ],
    [
      "insufficient_quota by type",
      JSON.stringify({ error: { type: "insufficient_quota" } }),
    ],
  ])(
    "recognises a billing error (%s) and calls it budget",
    async (_name, body) => {
      const { outcome } = await failWith(new Response(body, { status: 429 }));
      expect(outcome.value).toMatchObject({ kind: "budget", status: 429 });
    },
  );

  it("treats a plain 429 with a JSON body as busy, not budget", async () => {
    const { outcome } = await failWith(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
        status: 429,
      }),
    );
    expect(outcome.value).toMatchObject({ kind: "busy" });
  });

  it("maps a network error on the SDP request to network", async () => {
    const s = setup(
      sdpFetch(() => {
        throw new TypeError("fetch failed");
      }),
    );
    const { outcome } = start(s.transport);
    await settle();
    expect(outcome.value).toMatchObject({ kind: "network" });
    expect(s.pc().closeCalls).toBe(1);
  });

  it("maps a failure creating the offer to network", async () => {
    const fake = new FakePeerConnection();
    fake.offerError = new Error("boom");
    const transport = new WebRtcTransport({
      audioElement: fakeAudioElement(),
      createPeerConnection: () => asPc(fake),
      fetch: sdpFetch() as unknown as typeof fetch,
    });
    const { outcome } = start(transport);
    await settle();
    expect(outcome.value).toMatchObject({ kind: "network" });
    expect(fake.closeCalls).toBe(1);
  });

  it("fails when ICE fails before the session is up", async () => {
    const { transport, pc, states } = setup();
    const { outcome } = start(transport);
    await settle();
    pc().setIce("failed");
    await settle();
    expect(outcome.value).toMatchObject({ kind: "network" });
    expect(states).toEqual(["connecting", "failed"]);
    expect(pc().closeCalls).toBe(1);
  });

  it("fails when the channel closes before the session is up", async () => {
    const { transport, channel } = setup();
    const { outcome } = start(transport);
    await settle();
    channel().remoteClose();
    await settle();
    expect(outcome.value).toMatchObject({ kind: "network" });
  });

  it("times out after 15 s with nothing answering, and cleans up", async () => {
    const aborted = vi.fn();
    const hang = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => {
            aborted();
            rej(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const { transport, pc, channel, audio, states } = setup(hang as never);
    const { outcome } = start(transport);
    await settle();
    expect(CONNECT_TIMEOUT_MS).toBe(15_000);

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(outcome.value).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(outcome.value).toMatchObject({ kind: "timeout" });
    expect(aborted).toHaveBeenCalled();
    expect(pc().closeCalls).toBe(1);
    expect(channel().closeCalls).toBe(1);
    expect(audio.srcObject).toBeNull();
    expect(states).toEqual(["connecting", "failed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out when the answer is fine but session.created never comes", async () => {
    const { transport, pc, channel } = setup();
    const { outcome } = start(transport);
    await settle();
    channel().open();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await settle();
    expect(outcome.value).toMatchObject({ kind: "timeout" });
    expect(pc().closeCalls).toBe(1);
  });

  it("does not time out once connected", async () => {
    const { transport, channel, states } = setup();
    const { outcome } = start(transport);
    await settle();
    channel().open();
    channel().message(CREATED);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome.value).toBe("ok");
    expect(states).toEqual(["connecting", "connected"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts cleanly when close() runs mid-connect", async () => {
    const { transport, pc, channel, states } = setup();
    const { outcome } = start(transport);
    await settle();
    transport.close();
    await settle();
    expect(outcome.value).toMatchObject({ kind: "aborted" });
    expect(pc().closeCalls).toBe(1);
    expect(channel().closeCalls).toBe(1);
    expect(states.at(-1)).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never posts an offer for a connection closed while it was being made", async () => {
    const { transport, pc, fetchImpl } = setup();
    const { outcome } = start(transport);
    transport.close();
    await settle();
    expect(outcome.value).toMatchObject({ kind: "aborted" });
    expect(pc().closeCalls).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not apply an answer that arrives after close()", async () => {
    let release: (r: Response) => void = () => {};
    const slow = sdpFetch(
      () => new Promise<Response>((resolve) => (release = resolve)) as never,
    );
    const { transport, pc } = setup(slow);
    const { outcome } = start(transport);
    await settle();
    transport.close();
    release(new Response("v=0 late", { status: 201 }));
    await settle();
    expect(outcome.value).toMatchObject({ kind: "aborted" });
    expect(pc().remoteDescription).toBeNull();
  });
});

describe("once connected", () => {
  async function connected() {
    const s = setup();
    const { outcome } = start(s.transport);
    await settle();
    s.channel().open();
    s.channel().message(CREATED);
    await settle();
    expect(outcome.value).toBe("ok");
    return s;
  }

  it("sends client events as JSON, and reports when it cannot", async () => {
    const { transport, channel } = await connected();
    expect(transport.send(cancelResponse("evt_1"))).toBe(true);
    expect(JSON.parse(channel().sent[0] ?? "{}")).toEqual({
      type: "response.cancel",
      event_id: "evt_1",
    });
    channel().send.mockImplementationOnce(() => {
      throw new Error("closing");
    });
    expect(transport.send(cancelResponse("evt_2"))).toBe(false);
    channel().readyState = "closing";
    expect(transport.send(cancelResponse("evt_3"))).toBe(false);
  });

  it("cannot send before the channel is open", async () => {
    const { transport } = setup();
    expect(transport.send(cancelResponse("evt_1"))).toBe(false);
    start(transport);
    await settle();
    expect(transport.send(cancelResponse("evt_1"))).toBe(false);
  });

  it("reports a media path that drops and recovers", async () => {
    const { pc, states } = await connected();
    pc().setIce("disconnected");
    pc().setIce("connected");
    pc().setConnection("disconnected");
    pc().setConnection("connected");
    pc().setIce("completed");
    expect(states).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connected",
      "disconnected",
      "connected",
    ]);
  });

  it("reports failure when ICE or the connection fails, once", async () => {
    const { pc, states } = await connected();
    pc().setConnection("failed");
    pc().setIce("failed");
    expect(states).toEqual(["connecting", "connected", "failed"]);
  });

  it("reports failure when the channel closes under it", async () => {
    const { channel, states } = await connected();
    channel().remoteClose();
    expect(states).toEqual(["connecting", "connected", "failed"]);
  });

  it("ignores link changes it does not model", async () => {
    const { pc, states } = await connected();
    pc().setIce("checking");
    pc().setConnection("connecting");
    pc().setIce("disconnected");
    pc().setIce("disconnected");
    expect(states).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("close() releases everything once and ignores later events", async () => {
    const { transport, pc, channel, audio, states } = await connected();
    const seen: string[] = [];
    transport.onEvent((r) => seen.push(r));
    transport.close();
    transport.close();
    expect(pc().closeCalls).toBe(1);
    expect(channel().closeCalls).toBe(1);
    expect(audio.srcObject).toBeNull();
    expect(channel().onmessage).toBeNull();
    expect(pc().ontrack).toBeNull();
    expect(states).toEqual(["connecting", "connected", "closed"]);
    expect(transport.send(cancelResponse("evt_x"))).toBe(false);
    pc().setIce("failed");
    channel().message('{"type":"late"}');
    expect(seen).toEqual([]);
    expect(states.at(-1)).toBe("closed");
  });

  it("does not stop the mic: the caller owns it", async () => {
    const mic = new FakeStream();
    const s = setup();
    start(s.transport, asStream(mic));
    await settle();
    s.channel().open();
    s.channel().message(CREATED);
    await settle();
    s.transport.close();
    expect(mic.tracks[0]?.stop).not.toHaveBeenCalled();
  });
});
