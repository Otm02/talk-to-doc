import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeAudioContext,
  FakeStream,
  asAudioContext,
  asStream,
  fakeRaf,
} from "@test/realtime/fakes";
import { LevelMeter, rmsLevel } from "./levels";

beforeEach(() => FakeAudioContext.reset());

function setup(withContext = true) {
  const ctx = new FakeAudioContext();
  const frames = fakeRaf();
  const meter = new LevelMeter({
    audioContext: withContext ? asAudioContext(ctx) : null,
    raf: frames.raf,
    caf: frames.caf,
  });
  return { ctx, frames, meter };
}

describe("rmsLevel", () => {
  it("is 0 for silence and for nothing", () => {
    expect(rmsLevel([128, 128, 128])).toBe(0);
    expect(rmsLevel([])).toBe(0);
  });
  it("is 1 for a full-scale square wave and 0.5 for half scale", () => {
    expect(rmsLevel([0, 256 - 1 + 1, 0, 256])).toBeCloseTo(1, 5);
    expect(rmsLevel([64, 192, 64, 192])).toBeCloseTo(0.5, 5);
  });
});

describe("LevelMeter", () => {
  it("publishes a level per frame to subscribers, never touching React", () => {
    const { ctx, frames, meter } = setup();
    meter.attach("mic", asStream(new FakeStream()));
    const got: number[] = [];
    meter.subscribe("mic", (l) => got.push(l));
    expect(frames.pending).toBe(1);

    ctx.analysers[0]!.samples = [64, 192]; // rms 0.5 -> scaled and clamped
    frames.step();
    expect(got).toEqual([1]);
    expect(frames.pending).toBe(1);

    ctx.analysers[0]!.samples = [128];
    frames.step();
    // Releases slowly: 1 * 0.85, not an instant drop to silence.
    expect(got[1]).toBeCloseTo(0.85, 5);
    frames.step();
    expect(got[2]).toBeCloseTo(0.7225, 5);
  });

  it("scales speech-sized signals into the visible range", () => {
    const { ctx, frames, meter } = setup();
    meter.attach("remote", asStream(new FakeStream()));
    const got: number[] = [];
    meter.subscribe("remote", (l) => got.push(l));
    // Samples are bytes: +-13 is rms 13/128, x3 = 0.3047.
    ctx.analysers[0]!.samples = [141, 115];
    frames.step();
    expect(got[0]).toBeCloseTo(0.3046875, 5);
  });

  it("keeps the mic and the remote voice separate", () => {
    const { ctx, frames, meter } = setup();
    meter.attach("mic", asStream(new FakeStream()));
    meter.attach("remote", asStream(new FakeStream()));
    const mic: number[] = [];
    const remote: number[] = [];
    meter.subscribe("mic", (l) => mic.push(l));
    meter.subscribe("remote", (l) => remote.push(l));
    ctx.analysers[0]!.samples = [64, 192];
    ctx.analysers[1]!.samples = [128];
    frames.step();
    expect(mic).toEqual([1]);
    expect(remote).toEqual([0]);
  });

  it("does not run, or read audio, while nobody listens", () => {
    const { ctx, frames, meter } = setup();
    meter.attach("mic", asStream(new FakeStream()));
    expect(frames.pending).toBe(0);
    expect(meter.running).toBe(false);
    const off = meter.subscribe("mic", () => {});
    expect(meter.running).toBe(true);
    off();
    expect(frames.pending).toBe(0);
    expect(meter.running).toBe(false);
    expect(ctx.analysers[0]!.getByteTimeDomainData).not.toHaveBeenCalled();
  });

  it("only samples the kinds somebody listens to", () => {
    const { ctx, frames, meter } = setup();
    meter.attach("mic", asStream(new FakeStream()));
    meter.attach("remote", asStream(new FakeStream()));
    meter.subscribe("mic", () => {});
    frames.step();
    expect(ctx.analysers[0]!.getByteTimeDomainData).toHaveBeenCalledOnce();
    expect(ctx.analysers[1]!.getByteTimeDomainData).not.toHaveBeenCalled();
  });

  it("starts when a subscriber arrives before the stream does", () => {
    const { frames, meter } = setup();
    const got: number[] = [];
    meter.subscribe("mic", (l) => got.push(l));
    expect(frames.pending).toBe(0);
    meter.attach("mic", asStream(new FakeStream()));
    expect(frames.pending).toBe(1);
  });

  it("replaces a stream, disconnecting the old nodes and zeroing the bar", () => {
    const { ctx, meter } = setup();
    meter.attach("mic", asStream(new FakeStream()));
    const got: number[] = [];
    meter.subscribe("mic", (l) => got.push(l));
    meter.attach("mic", asStream(new FakeStream()));
    expect(ctx.sources[0]?.disconnect).toHaveBeenCalled();
    expect(ctx.analysers[0]?.disconnect).toHaveBeenCalled();
    expect(got).toContain(0);
    meter.attach("mic", null);
    expect(ctx.sources).toHaveLength(2);
  });

  it("never routes the analyser to the speakers", () => {
    const { ctx, meter } = setup();
    meter.attach("mic", asStream(new FakeStream()));
    expect(ctx.sources[0]?.connect).toHaveBeenCalledWith(ctx.analysers[0]);
    expect(ctx.sources[0]?.connect).toHaveBeenCalledTimes(1);
  });

  it("stays flat without an audio context or when the stream has no audio", () => {
    const none = setup(false);
    none.meter.attach("mic", asStream(new FakeStream()));
    none.meter.subscribe("mic", () => {});
    expect(none.frames.pending).toBe(0);

    const broken = setup();
    broken.ctx.failSource = true;
    broken.meter.attach("mic", asStream(new FakeStream()));
    broken.meter.subscribe("mic", () => {});
    expect(broken.frames.pending).toBe(0);
  });

  it("dispose releases everything and ignores later use", () => {
    const { ctx, frames, meter } = setup();
    meter.attach("mic", asStream(new FakeStream()));
    const l = vi.fn();
    meter.subscribe("mic", l);
    meter.dispose();
    meter.dispose();
    expect(frames.pending).toBe(0);
    expect(meter.running).toBe(false);
    expect(ctx.sources[0]?.disconnect).toHaveBeenCalled();
    meter.attach("mic", asStream(new FakeStream()));
    meter.subscribe("mic", l);
    expect(frames.pending).toBe(0);
    expect(ctx.sources).toHaveLength(1);
  });

  it("falls back to the browser's animation frame when none is injected", () => {
    const raf = vi.fn(() => 7);
    const caf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);
    const ctx = new FakeAudioContext();
    const meter = new LevelMeter({ audioContext: asAudioContext(ctx) });
    meter.attach("mic", asStream(new FakeStream()));
    meter.subscribe("mic", () => {});
    expect(raf).toHaveBeenCalled();
    meter.dispose();
    expect(caf).toHaveBeenCalledWith(7);
    vi.unstubAllGlobals();
  });
});
