// Audio levels for the mic and the model's voice. An AnalyserNode per stream
// is sampled once per animation frame and pushed to subscribers, which write
// to a ref or a style. It never goes through React state: 60 renders a
// second for a meter would be wasteful and janky on a phone.

export type LevelKind = "mic" | "remote";

export type LevelListener = (level: number) => void;

export interface LevelDeps {
  audioContext: AudioContext | null;
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
}

const FFT_SIZE = 256;
// Speech sits around 0.05-0.3 RMS; scale so normal talking fills most of the bar.
const GAIN = 3;
// Fast attack, slow release: a bar that follows syllables without flickering.
const DECAY = 0.85;

interface Channel {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Uint8Array<ArrayBuffer>;
  level: number;
}

/** Root-mean-square of unsigned 8-bit samples centred on 128, 0..1. */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = ((samples[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

export class LevelMeter {
  private channels = new Map<LevelKind, Channel>();
  private listeners: Record<LevelKind, Set<LevelListener>> = {
    mic: new Set(),
    remote: new Set(),
  };
  private frame: number | null = null;
  private disposed = false;
  private readonly raf: (cb: () => void) => number;
  private readonly caf: (id: number) => void;

  constructor(private readonly deps: LevelDeps) {
    this.raf = deps.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = deps.caf ?? ((id) => cancelAnimationFrame(id));
  }

  /** Replaces any earlier stream for this kind. Null just detaches. */
  attach(kind: LevelKind, stream: MediaStream | null): void {
    this.detach(kind);
    const ctx = this.deps.audioContext;
    if (this.disposed || !ctx || !stream) return;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      // Deliberately not connected to ctx.destination: that would play the
      // mic back to the user.
      source.connect(analyser);
      this.channels.set(kind, {
        source,
        analyser,
        buffer: new Uint8Array(analyser.fftSize),
        level: 0,
      });
    } catch {
      // A stream with no audio track: the meter stays at zero.
      return;
    }
    this.ensureLoop();
  }

  subscribe(kind: LevelKind, listener: LevelListener): () => void {
    this.listeners[kind].add(listener);
    this.ensureLoop();
    return () => {
      this.listeners[kind].delete(listener);
      this.stopIfIdle();
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const kind of this.channels.keys()) this.detach(kind);
    this.listeners.mic.clear();
    this.listeners.remote.clear();
    this.stopLoop();
  }

  /** True while an animation frame is queued. Tests use it to check for leaks. */
  get running(): boolean {
    return this.frame !== null;
  }

  private detach(kind: LevelKind): void {
    const ch = this.channels.get(kind);
    if (!ch) return;
    this.channels.delete(kind);
    try {
      ch.source.disconnect();
      ch.analyser.disconnect();
    } catch {
      // Already disconnected.
    }
    for (const l of this.listeners[kind]) l(0);
    this.stopIfIdle();
  }

  private active(): boolean {
    for (const kind of this.channels.keys()) {
      if (this.listeners[kind].size > 0) return true;
    }
    return false;
  }

  private ensureLoop(): void {
    if (this.disposed || this.frame !== null || !this.active()) return;
    this.frame = this.raf(this.tick);
  }

  private stopIfIdle(): void {
    if (!this.active()) this.stopLoop();
  }

  private stopLoop(): void {
    if (this.frame !== null) this.caf(this.frame);
    this.frame = null;
  }

  private tick = (): void => {
    this.frame = null;
    for (const [kind, ch] of this.channels) {
      if (this.listeners[kind].size === 0) continue;
      ch.analyser.getByteTimeDomainData(ch.buffer);
      const raw = Math.min(1, rmsLevel(ch.buffer) * GAIN);
      ch.level = Math.max(raw, ch.level * DECAY);
      for (const l of this.listeners[kind]) l(ch.level);
    }
    this.ensureLoop();
  };
}
