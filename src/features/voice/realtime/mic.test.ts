import { describe, expect, it, vi } from "vitest";
import { FakeStream, asStream } from "@test/realtime/fakes";
import {
  MIC_CONSTRAINTS,
  micFailureFromError,
  queryMicPermission,
  requestMic,
  stopStream,
} from "./mic";

const domError = (name: string) => Object.assign(new Error(name), { name });

describe("requestMic", () => {
  it("asks for mono audio with echo cancellation, noise suppression and AGC", async () => {
    const stream = asStream(new FakeStream());
    const getUserMedia = vi.fn(async () => stream);
    const result = await requestMic({
      isSecureContext: true,
      mediaDevices: { getUserMedia },
    });
    expect(result).toEqual({ ok: true, stream });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    expect(MIC_CONSTRAINTS.audio).toMatchObject({ channelCount: 1 });
  });

  it("refuses an insecure page without prompting", async () => {
    const getUserMedia = vi.fn();
    const result = await requestMic({
      isSecureContext: false,
      mediaDevices: { getUserMedia },
    });
    expect(result).toEqual({ ok: false, reason: "insecure" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports a browser with no media devices as unsupported", async () => {
    expect(await requestMic({ isSecureContext: true })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(
      await requestMic({
        isSecureContext: true,
        mediaDevices: {} as MediaDevices,
      }),
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["NotFoundError", "not_found"],
    ["DevicesNotFoundError", "not_found"],
    ["OverconstrainedError", "not_found"],
    ["NotReadableError", "in_use"],
    ["TrackStartError", "in_use"],
    ["AbortError", "in_use"],
    ["TypeError", "unavailable"],
    ["SomethingNew", "unavailable"],
  ])("maps %s to %s", async (name, reason) => {
    const getUserMedia = vi.fn(async () => {
      throw domError(name);
    });
    const result = await requestMic({
      isSecureContext: true,
      mediaDevices: { getUserMedia },
    });
    expect(result).toEqual({ ok: false, reason });
  });

  it("does not choke on a thrown non-error", () => {
    expect(micFailureFromError("boom")).toBe("unavailable");
    expect(micFailureFromError(null)).toBe("unavailable");
    expect(micFailureFromError(undefined)).toBe("unavailable");
  });

  it("reads the browser's own environment by default", async () => {
    const result = await requestMic();
    // Under node there is no mediaDevices: it must fail soft, not throw.
    expect(result.ok).toBe(false);
  });
});

describe("stopStream", () => {
  it("stops every track and tolerates null", () => {
    const stream = new FakeStream();
    stopStream(asStream(stream));
    expect(stream.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(() => stopStream(null)).not.toThrow();
  });
});

describe("queryMicPermission", () => {
  const withState = (state: string) => ({
    permissions: { query: vi.fn(async () => ({ state })) },
  });

  it.each(["granted", "denied", "prompt"] as const)(
    "reports %s as the browser gives it",
    async (state) => {
      const env = withState(state);
      await expect(queryMicPermission(env)).resolves.toBe(state);
      expect(env.permissions.query).toHaveBeenCalledWith({
        name: "microphone",
      });
    },
  );

  it("is unknown when there is no Permissions API", async () => {
    await expect(queryMicPermission({})).resolves.toBe("unknown");
    await expect(queryMicPermission({ permissions: undefined })).resolves.toBe(
      "unknown",
    );
    // No argument: reads the real navigator, which Node tests do not have.
    await expect(queryMicPermission()).resolves.toBe("unknown");
  });

  it("is unknown, not an error, when the browser rejects the microphone name", async () => {
    // Firefox: query() throws a TypeError for names it does not know.
    const throws = {
      permissions: {
        query: () => {
          throw new TypeError("'microphone' is not a valid PermissionName");
        },
      },
    };
    await expect(queryMicPermission(throws)).resolves.toBe("unknown");
    const rejects = {
      permissions: { query: async () => Promise.reject(new Error("nope")) },
    };
    await expect(queryMicPermission(rejects)).resolves.toBe("unknown");
  });

  it("is unknown for a state it has never heard of", async () => {
    await expect(queryMicPermission(withState("maybe"))).resolves.toBe(
      "unknown",
    );
  });
});
