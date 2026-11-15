import type { MicFailure } from "./failure";

// Microphone access, with failures typed so the UI can fall back to text mode
// with the right words (SPEC section 4.2) instead of showing a DOMException.

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};

export type MicResult =
  { ok: true; stream: MediaStream } | { ok: false; reason: MicFailure };

export interface MicEnvironment {
  isSecureContext: boolean;
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | undefined;
}

function browserEnvironment(): MicEnvironment {
  return {
    isSecureContext: globalThis.isSecureContext ?? false,
    mediaDevices: globalThis.navigator?.mediaDevices,
  };
}

/** "unknown" = the browser cannot say (no Permissions API, or not for the mic). */
export type MicPermission = "granted" | "denied" | "prompt" | "unknown";

export interface PermissionEnvironment {
  permissions?:
    | { query(descriptor: { name: string }): Promise<{ state: string }> }
    | undefined;
}

/**
 * What the browser would do if we asked for the mic now, without asking.
 * "denied" means getUserMedia would fail with no prompt, so a retry can go
 * straight to explaining how to change the setting. It never throws: Firefox
 * and older Safari reject the "microphone" name, and that just means unknown.
 */
export async function queryMicPermission(
  env: PermissionEnvironment = {
    permissions: globalThis.navigator?.permissions,
  },
): Promise<MicPermission> {
  try {
    const status = await env.permissions?.query({ name: "microphone" });
    const state = status?.state;
    return state === "granted" || state === "denied" || state === "prompt"
      ? state
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function micFailureFromError(err: unknown): MicFailure {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String(err.name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    // Our constraints are loose, so an overconstrained error means no device.
    case "OverconstrainedError":
      return "not_found";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "in_use";
    default:
      return "unavailable";
  }
}

/**
 * Must be called from the user's tap (before any other await) so iOS Safari
 * and the permission prompt treat it as a gesture.
 */
export async function requestMic(
  env: MicEnvironment = browserEnvironment(),
): Promise<MicResult> {
  // getUserMedia exists only on secure origins (https or localhost).
  if (!env.isSecureContext) return { ok: false, reason: "insecure" };
  if (!env.mediaDevices?.getUserMedia) {
    return { ok: false, reason: "unsupported" };
  }
  try {
    const stream = await env.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, reason: micFailureFromError(err) };
  }
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
