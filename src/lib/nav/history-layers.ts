// The Android Back button and the browser's Back act on the history list, and
// this app is one page. Without help, Back from a chat leaves the site. A
// "layer" is something Back should close first (a sheet, the chat, the ready
// document): opening one pushes a history entry, and Back pops it and closes
// the layer. Nothing is stored server-side and the URL never changes.

interface Layer {
  /** Position in the history list, counted from the page's own entry (0). */
  depth: number;
  /** true: closed. false: stay, and keep the entry (the layer asked to). */
  onBack: () => boolean;
}

const stack: Layer[] = [];
/** How many of our entries sit above the page's own, as far as we know. */
let historyDepth = 0;
/** history.go() calls whose popstate has not arrived yet. */
let travelling = 0;
let travelTimer: ReturnType<typeof setTimeout> | undefined;
let waiting: Array<() => void> = [];
let started = false;
let reconcileQueued = false;

/** A traversal that never reports back must not freeze every later push. */
const TRAVEL_GIVE_UP_MS = 1000;

function depthOf(state: unknown): number {
  if (typeof state !== "object" || state === null || !("ttd" in state)) {
    return 0;
  }
  return typeof state.ttd === "number" ? state.ttd : 0;
}

function start(): void {
  if (started) return;
  started = true;
  window.addEventListener("popstate", onPopState);
  // After a reload the browser hands back the old entry with its marker, but
  // none of its layers exist any more: treat the entry as the page's own.
  if (depthOf(window.history.state) > 0) {
    window.history.replaceState(null, "");
  }
}

function settled(): void {
  travelling = 0;
  clearTimeout(travelTimer);
  const run = waiting;
  waiting = [];
  for (const fn of run) fn();
}

function onPopState(event: PopStateEvent): void {
  const landed = depthOf(event.state);
  historyDepth = landed;
  if (travelling > 0) {
    travelling -= 1;
    if (travelling === 0) settled();
  }
  // Back (or a long press on it) went below these layers: close them, top first.
  for (let top = stack.at(-1); top && top.depth > landed; top = stack.at(-1)) {
    stack.pop();
    if (top.onBack()) continue;
    // The layer wants to stay (it is asking "leave?"): put its entry back.
    stack.push(top);
    window.history.pushState({ ttd: top.depth }, "");
    historyDepth = top.depth;
    break;
  }
}

/** Drops entries nobody needs: a layer closed from the screen, not by Back. */
function reconcile(): void {
  reconcileQueued = false;
  const target = stack.at(-1)?.depth ?? 0;
  if (historyDepth <= target) return;
  const delta = target - historyDepth;
  historyDepth = target;
  travelling += 1;
  clearTimeout(travelTimer);
  travelTimer = setTimeout(settled, TRAVEL_GIVE_UP_MS);
  window.history.go(delta);
}

/**
 * Registers a layer and returns the function that closes it from the screen.
 * Closing by Back is the layer's own business (`onBack`); closing from the
 * screen takes its history entry away so Back does not land on a ghost.
 */
export function pushLayer(onBack: () => boolean): () => void {
  start();
  let layer: Layer | null = null;
  let cancelled = false;

  const register = () => {
    if (cancelled) return;
    const depth = (stack.at(-1)?.depth ?? 0) + 1;
    layer = { depth, onBack };
    stack.push(layer);
    // An entry left over from a layer that closed a moment ago is reused.
    if (historyDepth < depth) {
      window.history.pushState({ ttd: depth }, "");
      historyDepth = depth;
    }
  };
  if (travelling > 0) waiting.push(register);
  else register();

  return () => {
    cancelled = true;
    if (!layer) return;
    const at = stack.indexOf(layer);
    if (at >= 0) stack.splice(at, 1);
    layer = null;
    // Batched: a chat and its sheet usually close in the same render.
    if (!reconcileQueued) {
      reconcileQueued = true;
      queueMicrotask(reconcile);
    }
  };
}

/** For tests: forget every layer and listener. */
export function resetHistoryLayers(): void {
  if (started) window.removeEventListener("popstate", onPopState);
  stack.length = 0;
  historyDepth = 0;
  travelling = 0;
  clearTimeout(travelTimer);
  waiting = [];
  started = false;
  reconcileQueued = false;
}
