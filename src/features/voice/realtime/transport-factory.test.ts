import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeAudioElement } from "@test/realtime/fakes";
import { MockTransport } from "./mock-transport";
import { TransportError } from "./transport";
import { isMockNet } from "./mock-names";
import {
  createTransport,
  mockScenarioFromSearch,
  netScript,
  resetMockNetForTests,
} from "./transport-factory";
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

describe("scripted network trouble (?mockNet)", () => {
  it("only the first transport of a page misbehaves", () => {
    for (const name of [
      "drop-recover",
      "drop-timeout",
      "failed",
      "expired",
    ] as const) {
      const first = netScript(name, 0);
      const second = netScript(name, 1);
      expect(
        (first.linkSteps?.length ?? 0) + first.steps.length,
      ).toBeGreaterThan(0);
      expect(second).toEqual({ steps: [] });
    }
  });

  it("'dead' keeps failing every connect after the first", () => {
    expect(netScript("dead", 0).linkSteps).toEqual([
      { at: 600, state: "failed" },
    ]);
    expect(netScript("dead", 1).failWith).toBe("network");
    expect(netScript("dead", 5).failWith).toBe("network");
  });

  it("drop-recover heals the link two seconds later", () => {
    expect(netScript("drop-recover", 0).linkSteps).toEqual([
      { at: 600, state: "disconnected" },
      { at: 2600, state: "connected" },
    ]);
  });

  it("builds the scripted mock for the first transport and a clean one after", async () => {
    resetMockNetForTests();
    const search = "?mockRealtime=text-turn&mockNet=failed";
    vi.useFakeTimers();
    try {
      const seen: string[][] = [[], []];
      for (const i of [0, 1]) {
        const t = await createTransport({ audioElement: null }, search);
        expect(t).toBeInstanceOf(MockTransport);
        t.onStateChange((s) => seen[i]?.push(s));
        const p = t.connect({ clientSecret: "x", micStream: null });
        await vi.advanceTimersByTimeAsync(1_000);
        await p;
        t.close();
      }
      expect(seen[0]).toContain("failed");
      expect(seen[1]).not.toContain("failed");
    } finally {
      vi.useRealTimers();
      resetMockNetForTests();
    }
  });

  it("knows the scenario names", () => {
    expect(isMockNet("dead")).toBe(true);
    expect(isMockNet("nope")).toBe(false);
    expect(isMockNet(null)).toBe(false);
  });
});
