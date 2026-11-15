import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeAudioElement } from "@test/realtime/fakes";
import { MockTransport } from "./mock-transport";
import { TransportError } from "./transport";
import { createTransport, mockScenarioFromSearch } from "./transport-factory";
import { WebRtcTransport } from "./webrtc-transport";

afterEach(() => vi.unstubAllGlobals());

describe("mockScenarioFromSearch", () => {
  it("reads a known scenario name from the URL", () => {
    expect(mockScenarioFromSearch("?mockRealtime=barge-in", true)).toBe(
      "barge-in",
    );
    expect(mockScenarioFromSearch("?x=1&mockRealtime=text-turn", true)).toBe(
      "text-turn",
    );
  });
  it("ignores unknown names and a missing flag", () => {
    expect(mockScenarioFromSearch("?mockRealtime=nope", true)).toBeNull();
    expect(mockScenarioFromSearch("", true)).toBeNull();
  });
  it("is off entirely when the mock is not allowed (a production build)", () => {
    expect(mockScenarioFromSearch("?mockRealtime=barge-in", false)).toBeNull();
  });
});

describe("createTransport", () => {
  it("builds the mock for a mock scenario", async () => {
    const t = await createTransport(
      { audioElement: null },
      "?mockRealtime=normal-turn",
    );
    expect(t).toBeInstanceOf(MockTransport);
  });

  it("can slow the mock's replies down for a test", async () => {
    const t = await createTransport(
      { audioElement: null },
      "?mockRealtime=text-turn&mockWordMs=400",
    );
    const slow: string[] = [];
    t.onEvent((raw) => slow.push(raw));
    vi.useFakeTimers();
    try {
      const p = t.connect({ clientSecret: "x", micStream: null });
      await vi.advanceTimersByTimeAsync(200);
      await p;
      t.send({ type: "response.create", event_id: "e" });
      await vi.advanceTimersByTimeAsync(300);
      expect(slow.filter((r) => r.includes("output_text.delta"))).toHaveLength(
        0,
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(
        slow.filter((r) => r.includes("output_text.delta")).length,
      ).toBeGreaterThan(0);
    } finally {
      t.close();
      vi.useRealTimers();
    }
  });

  it("lets the URL make the in-place mic upgrade refuse", async () => {
    vi.useFakeTimers();
    try {
      for (const [query, accepted] of [
        ["?mockRealtime=text-turn", true],
        ["?mockRealtime=text-turn&mockMicUpgrade=fail", false],
      ] as const) {
        const t = await createTransport({ audioElement: null }, query);
        const p = t.connect({ clientSecret: "x", micStream: null });
        await vi.advanceTimersByTimeAsync(200);
        await p;
        await expect(t.upgradeMic({} as MediaStream)).resolves.toBe(accepted);
        t.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds the WebRTC transport otherwise", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    const t = await createTransport({ audioElement: fakeAudioElement() }, "");
    expect(t).toBeInstanceOf(WebRtcTransport);
  });

  it("reports an unsupported browser, or a missing audio element, as such", async () => {
    await expect(
      createTransport({ audioElement: fakeAudioElement() }, ""),
    ).rejects.toMatchObject({
      kind: "unsupported",
    });
    vi.stubGlobal("RTCPeerConnection", class {});
    await expect(
      createTransport({ audioElement: null }, ""),
    ).rejects.toBeInstanceOf(TransportError);
  });
});
