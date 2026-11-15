import type { ClientEvent } from "./client-events";

// What the session controller needs from a connection to OpenAI, and nothing
// more. WebRtcTransport is the real one; MockTransport replays scripts so
// tests and Playwright never touch the network.

export type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  /** Media path interrupted. It may recover on its own; the caller decides how long to wait. */
  | "disconnected"
  | "failed"
  | "closed";

export type TransportErrorKind =
  /** No data channel + session.created inside the deadline. */
  | "timeout"
  /** The SDP exchange was refused. */
  | "rejected"
  /** 429 or 5xx on the SDP exchange. */
  | "busy"
  /** A billing or quota error: never retried. */
  | "budget"
  /** Could not reach OpenAI, or the media path failed during connect. */
  | "network"
  /** close() ran while connecting. */
  | "aborted"
  /** The browser has no WebRTC. */
  | "unsupported";

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    readonly status?: number,
  ) {
    super(`Realtime transport failed: ${kind}${status ? ` (${status})` : ""}`);
    this.name = "TransportError";
  }
}

export interface ConnectOptions {
  /** The short-lived secret from our server. Never logged or stored. */
  clientSecret: string;
  /** null = text mode: nothing is sent yet, but upgradeMic() can add it later. */
  micStream: MediaStream | null;
}

export interface RealtimeTransport {
  /**
   * Resolves once the data channel is open AND session.created has been
   * delivered to onEvent listeners. Rejects with TransportError.
   */
  connect(options: ConnectOptions): Promise<void>;
  /** false when the channel cannot take the event right now. */
  send(event: ClientEvent): boolean;
  /**
   * Starts sending this microphone on the connection that already exists: no
   * new offer, no new client secret. Resolves false when that is not possible
   * (the caller then reconnects once); never rejects.
   */
  upgradeMic(stream: MediaStream): Promise<boolean>;
  /** Idempotent. Releases everything the transport created. */
  close(): void;
  /** Raw data-channel messages. Returns an unsubscribe function. */
  onEvent(listener: (raw: string) => void): () => void;
  onStateChange(listener: (state: TransportState) => void): () => void;
  /** The model's audio, for the level meter. */
  onRemoteStream(listener: (stream: MediaStream) => void): () => void;
}
