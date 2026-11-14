import { isBillingCode } from "./failure";
import type { ClientEvent } from "./client-events";
import {
  TransportError,
  type ConnectOptions,
  type RealtimeTransport,
  type TransportState,
} from "./transport";

// WebRTC to OpenAI per docs/reference/openai-realtime.md section 2: the
// browser posts its SDP offer straight to /v1/realtime/calls with the
// ephemeral secret; the data channel "oai-events" carries JSON events both
// ways, and the model's audio arrives as a remote track.

export const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const CONNECT_TIMEOUT_MS = 15_000;
export const DATA_CHANNEL_LABEL = "oai-events";

export interface WebRtcDeps {
  /** The <audio autoplay playsinline> element, created inside the user's tap. */
  audioElement: HTMLAudioElement;
  createPeerConnection?: () => RTCPeerConnection;
  fetch?: typeof fetch;
  callsUrl?: string;
  connectTimeoutMs?: number;
}

const noop = () => {};

export class WebRtcTransport implements RealtimeTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: TransportState = "idle";
  private closed = false;
  private used = false;
  private channelOpen = false;
  private sessionCreated = false;
  private failConnect: ((e: TransportError) => void) | null = null;
  private readyCheck: (() => void) | null = null;

  private readonly eventListeners = new Set<(raw: string) => void>();
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private readonly streamListeners = new Set<(s: MediaStream) => void>();

  constructor(private readonly deps: WebRtcDeps) {}

  onEvent(listener: (raw: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onStateChange(listener: (s: TransportState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onRemoteStream(listener: (s: MediaStream) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  send(event: ClientEvent): boolean {
    if (this.dc?.readyState !== "open") return false;
    try {
      this.dc.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  async connect(options: ConnectOptions): Promise<void> {
    if (this.used) throw new TransportError("aborted");
    this.used = true;
    this.setState("connecting");

    const abort = new AbortController();
    this.abort = abort;
    const timeoutMs = this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

    const timeout = new Promise<never>((_, reject) => {
      this.timer = setTimeout(() => {
        reject(new TransportError("timeout"));
      }, timeoutMs);
    });
    const ready = new Promise<void>((resolve, reject) => {
      this.failConnect = reject;
      this.readyCheck = () => {
        if (this.channelOpen && this.sessionCreated) resolve();
      };
    });
    // Whichever of these loses the race must not become an unhandled rejection.
    ready.catch(noop);
    timeout.catch(noop);

    try {
      await Promise.race([
        this.negotiate(options, abort.signal, ready),
        timeout,
      ]);
      this.setState("connected");
    } catch (err) {
      const error = this.normalize(err);
      this.release();
      this.setState(this.closed ? "closed" : "failed");
      throw error;
    } finally {
      this.clearTimer();
      this.failConnect = null;
      this.readyCheck = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failConnect?.(new TransportError("aborted"));
    this.release();
    this.setState("closed");
    this.eventListeners.clear();
    this.stateListeners.clear();
    this.streamListeners.clear();
  }

  // ------------------------------------------------------------ internals

  private async negotiate(
    options: ConnectOptions,
    signal: AbortSignal,
    ready: Promise<void>,
  ): Promise<void> {
    const create =
      this.deps.createPeerConnection ?? (() => new RTCPeerConnection());
    const pc = create();
    this.pc = pc;

    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.deps.audioElement.srcObject = stream;
      // Autoplay normally starts it; this covers browsers that need a nudge.
      void this.deps.audioElement.play?.()?.catch(noop);
      for (const l of this.streamListeners) l(stream);
    };
    pc.onconnectionstatechange = () => this.onLink(pc.connectionState);
    pc.oniceconnectionstatechange = () => this.onLink(pc.iceConnectionState);

    const track = options.micStream?.getAudioTracks()[0];
    if (options.micStream && track) {
      pc.addTrack(track, options.micStream);
    } else {
      // Text mode still needs an audio m-line in the offer to receive replies.
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    // Created before the offer, or the channel is not part of the SDP.
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL);
    this.dc = dc;
    dc.onopen = () => {
      this.channelOpen = true;
      this.readyCheck?.();
    };
    dc.onmessage = (e: MessageEvent) => {
      if (typeof e.data === "string") this.onMessage(e.data);
    };
    dc.onclose = () => {
      if (this.closed) return;
      if (this.failConnect) this.failConnect(new TransportError("network"));
      else this.fail();
    };

    // After every await: close() may have run, and posting an offer for a
    // session nobody wants would start a call on OpenAI's side.
    const offer = await pc.createOffer();
    this.assertOpen();
    await pc.setLocalDescription(offer);
    this.assertOpen();

    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.deps.callsUrl ?? CALLS_URL, {
        method: "POST",
        body: offer.sdp,
        headers: {
          authorization: `Bearer ${options.clientSecret}`,
          "content-type": "application/sdp",
        },
        signal,
      });
    } catch {
      throw new TransportError("network");
    }
    this.assertOpen();
    if (!res.ok) throw await classifyFailure(res);

    const answer = await res.text();
    this.assertOpen();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    await ready;
  }

  private assertOpen(): void {
    if (this.closed) throw new TransportError("aborted");
  }

  private onMessage(raw: string): void {
    for (const l of this.eventListeners) l(raw);
    if (!this.sessionCreated && isSessionCreated(raw)) {
      this.sessionCreated = true;
      this.readyCheck?.();
    }
  }

  /** ICE / peer connection state, folded into our smaller vocabulary. */
  private onLink(link: RTCPeerConnectionState | RTCIceConnectionState): void {
    if (this.closed) return;
    switch (link) {
      case "connected":
      case "completed":
        if (this.state === "disconnected") this.setState("connected");
        break;
      case "disconnected":
        if (this.state === "connected") this.setState("disconnected");
        break;
      case "failed":
        if (this.failConnect) this.failConnect(new TransportError("network"));
        else this.fail();
        break;
      default:
        break;
    }
  }

  /** The link died after connecting. The controller decides what happens next. */
  private fail(): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.setState("failed");
  }

  private normalize(err: unknown): TransportError {
    if (this.closed) return new TransportError("aborted");
    if (err instanceof TransportError) return err;
    return new TransportError("network");
  }

  private setState(next: TransportState): void {
    if (this.state === next) return;
    this.state = next;
    for (const l of this.stateListeners) l(next);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Everything the transport created, released once. The mic is the caller's. */
  private release(): void {
    this.clearTimer();
    this.abort?.abort();
    this.abort = null;
    const { dc, pc } = this;
    this.dc = null;
    this.pc = null;
    if (dc) {
      dc.onopen = null;
      dc.onmessage = null;
      dc.onclose = null;
      dc.onerror = null;
      try {
        dc.close();
      } catch {
        // Already closed.
      }
    }
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Already closed.
      }
    }
    this.deps.audioElement.srcObject = null;
  }
}

function isSessionCreated(raw: string): boolean {
  try {
    const v: unknown = JSON.parse(raw);
    return (
      typeof v === "object" &&
      v !== null &&
      "type" in v &&
      v.type === "session.created"
    );
  } catch {
    return false;
  }
}

async function classifyFailure(res: Response): Promise<TransportError> {
  let code: string | undefined;
  try {
    const body: unknown = JSON.parse((await res.text()).slice(0, 4096));
    if (typeof body === "object" && body !== null && "error" in body) {
      const e = body.error;
      if (typeof e === "object" && e !== null) {
        const c = "code" in e ? e.code : undefined;
        const t = "type" in e ? e.type : undefined;
        code =
          typeof c === "string" ? c : typeof t === "string" ? t : undefined;
      }
    }
  } catch {
    // Not JSON: the status alone decides.
  }
  if (isBillingCode(code)) return new TransportError("budget", res.status);
  if (res.status === 429 || res.status >= 500) {
    return new TransportError("busy", res.status);
  }
  return new TransportError("rejected", res.status);
}
