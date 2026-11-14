// Browser audio objects that must be created inside the user's tap: iOS
// Safari only lets audio start from a gesture, so the element and the
// AudioContext exist (and the context is resumed) before any await.

/** The sink for the model's voice: <audio autoplay playsinline>. */
export function createRemoteAudioElement(
  doc: Document = document,
): HTMLAudioElement {
  const el = doc.createElement("audio");
  el.autoplay = true;
  // Keeps iOS Safari from taking the audio full screen.
  el.setAttribute("playsinline", "");
  el.hidden = true;
  doc.body.appendChild(el);
  return el;
}

export function removeAudioElement(el: HTMLAudioElement | null): void {
  if (!el) return;
  el.srcObject = null;
  el.remove();
}

type AudioContextCtor = typeof AudioContext;

/** null when the browser has none; the level meter just stays flat. */
export function createAudioContext(
  win: {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  } = globalThis as never,
): AudioContext | null {
  const Ctor = win.AudioContext ?? win.webkitAudioContext;
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}
