import { vi } from "vitest";

// Minimal stand-ins for browser media and WebRTC objects. They record calls
// in order so tests can assert sequencing (data channel before the offer) and
// release (every track stopped, every connection closed).

export class FakeTrack {
  readonly kind = "audio";
  enabled = true;
  readyState: "live" | "ended" = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener = vi.fn((type: string, fn: () => void) => {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  });
  removeEventListener = vi.fn((type: string, fn: () => void) => {
    this.listeners.get(type)?.delete(fn);
  });
  listenerCount = (type: string) => this.listeners.get(type)?.size ?? 0;
  /** The device went away: unplugged, revoked in the OS, or taken by another app. */
  end() {
    this.readyState = "ended";
    for (const fn of [...(this.listeners.get("ended") ?? [])]) fn();
  }
}

export class FakeStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks;
}

export const asStream = (s: FakeStream) => s as unknown as MediaStream;

export class FakeDataChannel {
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;
  constructor(readonly label: string) {}
  send = vi.fn((data: string) => {
    this.sent.push(data);
  });
  close = vi.fn(() => {
    this.closeCalls += 1;
    this.readyState = "closed";
  });
  // test controls
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  remoteClose() {
    this.readyState = "closed";
    this.onclose?.();
  }
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  /** Call names in the order they happened. */
  log: string[] = [];
  channel: FakeDataChannel | null = null;
  tracksAdded: unknown[] = [];
  transceivers: Array<{ kind: string; init: unknown }> = [];
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  closeCalls = 0;
  connectionState: string = "new";
  iceConnectionState: string = "new";
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  /** Make the next createOffer fail, e.g. after close. */
  offerError: Error | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack = vi.fn((track: unknown, stream: unknown) => {
    this.log.push("addTrack");
    this.tracksAdded.push([track, stream]);
    return {};
  });
  addTransceiver = vi.fn((kind: string, init: unknown) => {
    this.log.push("addTransceiver");
    this.transceivers.push({ kind, init });
    return {};
  });
  createDataChannel = vi.fn((label: string) => {
    this.log.push("createDataChannel");
    this.channel = new FakeDataChannel(label);
    return this.channel;
  });
  createOffer = vi.fn(async () => {
    this.log.push("createOffer");
    if (this.offerError) throw this.offerError;
    return { type: "offer", sdp: "v=0 fake-offer" };
  });
  setLocalDescription = vi.fn(async (d: unknown) => {
    this.log.push("setLocalDescription");
    this.localDescription = d;
  });
  setRemoteDescription = vi.fn(async (d: unknown) => {
    this.log.push("setRemoteDescription");
    this.remoteDescription = d;
  });
  close = vi.fn(() => {
    this.closeCalls += 1;
    this.connectionState = "closed";
  });

  // test controls
  setConnection(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  setIce(state: string) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
  fireTrack(stream: FakeStream | null, track: FakeTrack = new FakeTrack()) {
    this.ontrack?.({ streams: stream ? [stream] : [], track });
  }

  static reset() {
    FakePeerConnection.instances = [];
  }
}

export const asPc = (p: FakePeerConnection) =>
  p as unknown as RTCPeerConnection;

export function fakeAudioElement() {
  const el = {
    srcObject: null as unknown,
    play: vi.fn(() => Promise.resolve()),
  };
  return el as unknown as HTMLAudioElement & { play: ReturnType<typeof vi.fn> };
}

/** A fetch that answers the SDP exchange. */
export function sdpFetch(
  respond: () => Response | Promise<Response> = () =>
    new Response("v=0 fake-answer", { status: 201 }),
) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => respond(),
  );
}

// ---------------------------------------------------------------- audio

export class FakeAnalyser {
  fftSize = 0;
  /** Samples the next getByteTimeDomainData call writes (128 = silence). */
  samples: number[] = [];
  disconnect = vi.fn();
  getByteTimeDomainData = vi.fn((buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++)
      buf[i] = this.samples[i % (this.samples.length || 1)] ?? 128;
  });
}

export class FakeSource {
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(readonly stream: unknown) {}
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: "suspended" | "running" | "closed" = "suspended";
  analysers: FakeAnalyser[] = [];
  sources: FakeSource[] = [];
  closeCalls = 0;
  resumeCalls = 0;
  failSource = false;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createAnalyser = vi.fn(() => {
    const a = new FakeAnalyser();
    this.analysers.push(a);
    return a;
  });
  createMediaStreamSource = vi.fn((stream: unknown) => {
    if (this.failSource) throw new Error("no audio tracks");
    const s = new FakeSource(stream);
    this.sources.push(s);
    return s;
  });
  resume = vi.fn(async () => {
    this.resumeCalls += 1;
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.closeCalls += 1;
    this.state = "closed";
  });
  static reset() {
    FakeAudioContext.instances = [];
  }
}

export const asAudioContext = (c: FakeAudioContext) =>
  c as unknown as AudioContext;

/** A manual requestAnimationFrame: nothing runs until step(). */
export function fakeRaf() {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    raf: (cb: () => void) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    caf: (id: number) => {
      queue.delete(id);
    },
    step() {
      const entries = [...queue.entries()];
      queue.clear();
      for (const [, cb] of entries) cb();
    },
    get pending() {
      return queue.size;
    },
  };
}
