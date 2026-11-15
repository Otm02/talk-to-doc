// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicEnv } from "@/lib/public-env";
import { LevelMeter } from "./levels";
import { MockTransport } from "./mock-transport";
import { EventRecorder } from "./recorder";
import { createBrowserDeps } from "./session-deps";

// The unit-test build is a dev build, not a mock build: flip the flag per test.
vi.mock("@/lib/public-env", () => ({
  publicEnv: { isDev: true, realtimeTransport: "webrtc" as "webrtc" | "mock" },
}));

function at(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}

afterEach(() => {
  (publicEnv as { realtimeTransport: string }).realtimeTransport = "webrtc";
  at("");
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("createBrowserDeps", () => {
  it("answers the mint itself in mock mode, with no request", async () => {
    at("?mockRealtime=normal-turn");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await createBrowserDeps().mint(
      "doc",
      new AbortController().signal,
    );
    expect(out).toMatchObject({
      model: "gpt-realtime-2.1-mini",
      maxSessionSeconds: 300,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("lets a test shorten the chat cap in mock mode", async () => {
    at("?mockRealtime=normal-turn&mockCap=90");
    expect(
      (await createBrowserDeps().mint("doc", new AbortController().signal))
        .maxSessionSeconds,
    ).toBe(90);
    at("?mockRealtime=normal-turn&mockCap=abc");
    expect(
      (await createBrowserDeps().mint("doc", new AbortController().signal))
        .maxSessionSeconds,
    ).toBe(300);
  });

  it("can refuse the mint with a code and a wait, in mock mode", async () => {
    at("?mockRealtime=normal-turn&mockMintError=daily_limit&mockRetryAfter=30");
    await expect(
      createBrowserDeps().mint("doc", new AbortController().signal),
    ).rejects.toMatchObject({ code: "daily_limit", retryAfterSeconds: 30 });
    at("?mockRealtime=normal-turn&mockMintError=nonsense");
    await expect(
      createBrowserDeps().mint("doc", new AbortController().signal),
    ).rejects.toMatchObject({
      code: "session_connect_failed",
      retryAfterSeconds: undefined,
    });
  });

  it("asks the real endpoint otherwise", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "daily_limit" } }), {
          status: 429,
        }),
    );
    vi.stubGlobal("fetch", f);
    await expect(
      createBrowserDeps().mint("doc", new AbortController().signal),
    ).rejects.toMatchObject({
      code: "daily_limit",
    });
    expect(f).toHaveBeenCalledWith("/api/realtime/session", expect.anything());
  });

  it("builds the transport the URL asks for", async () => {
    at("?mockRealtime=barge-in");
    expect(
      await createBrowserDeps().createTransport({ audioElement: null }),
    ).toBeInstanceOf(MockTransport);
  });

  it("creates and removes the audio element, the context, the meter and the recorder", () => {
    const deps = createBrowserDeps();
    const el = deps.createAudioElement();
    expect(el && document.body.contains(el)).toBe(true);
    deps.removeAudioElement(el);
    expect(el && document.body.contains(el)).toBe(false);
    expect(deps.createAudioContext()).toBeNull(); // jsdom has no AudioContext
    expect(deps.createLevelMeter(null)).toBeInstanceOf(LevelMeter);
    expect(deps.createRecorder()).toBeInstanceOf(EventRecorder); // dev build
    expect(deps.now()).toBeGreaterThan(0);
    expect(deps.isDebug()).toBe(true);
  });

  it("reports a missing mic API softly", async () => {
    const result = await createBrowserDeps().requestMic();
    expect(result.ok).toBe(false);
  });

  it("asks the browser's Permissions API about the mic", async () => {
    // jsdom has none: unknown, not an error.
    await expect(createBrowserDeps().queryMicPermission()).resolves.toBe(
      "unknown",
    );
    const query = vi.fn(async () => ({ state: "denied" }));
    vi.stubGlobal("navigator", { permissions: { query } });
    await expect(createBrowserDeps().queryMicPermission()).resolves.toBe(
      "denied",
    );
    expect(query).toHaveBeenCalledWith({ name: "microphone" });
  });

  it("follows the page's visibility", () => {
    const { visibility } = createBrowserDeps();
    const listener = vi.fn();
    const off = visibility.subscribe(listener);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledOnce();
    expect(typeof visibility.isHidden()).toBe("boolean");
    off();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("createBrowserDeps: ?mockMint=route", () => {
  const sessionBody = {
    clientSecret: "s",
    expiresAt: 0,
    model: "gpt-realtime-2.1-mini",
    maxSessionSeconds: 300,
  };

  it("in a mock build sends the mint through the real client, so a route can answer it", async () => {
    (publicEnv as { realtimeTransport: string }).realtimeTransport = "mock";
    at("?mockRealtime=normal-turn&mockMint=route");
    const f = vi.fn(async () => Response.json(sessionBody));
    vi.stubGlobal("fetch", f);
    await createBrowserDeps().mint("doc", new AbortController().signal);
    expect(f).toHaveBeenCalledWith("/api/realtime/session", expect.anything());
  });

  it("in a dev build it stays mocked: the real route would be a live OpenAI call", async () => {
    at("?mockRealtime=normal-turn&mockMint=route");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await createBrowserDeps().mint(
      "doc",
      new AbortController().signal,
    );
    expect(out).toMatchObject({ clientSecret: "mock-secret" });
    expect(f).not.toHaveBeenCalled();
  });
});
