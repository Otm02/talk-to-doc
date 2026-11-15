import type { FailureCode } from "./failure";
import type { ConnectionState } from "./state";
import type { TransportErrorKind } from "./transport";

// The reconnect state machine, pure: (state, input) -> (state, effects).
// The session controller feeds it what happened (link events, timers, mint and
// connect results) and carries out the effects it returns, so every rule about
// when to wait, retry, cool down or give up is testable with plain values.
//
// Rules, from the M9 brief:
//  - "disconnected" waits up to 8 s for the link to heal by itself (grace).
//  - "failed", a channel that closed on us, a session-expired error, or the
//    end of the grace period start a new session: one mint per attempt, at
//    most 3 attempts, backoff 0 / 2 / 4 s between them.
//  - While the device is offline nothing is minted. Waiting for the network
//    does not use up an attempt.
//  - A 429 goes to cooldown for exactly the wait the server gave, then makes
//    ONE more attempt. It uses up its attempt, so it can never become a loop.
//  - voice_disabled, daily_limit and budget_exhausted never reconnect.
//  - Attempts are counted per outage, but a link that comes back and drops
//    again within STABILITY_WINDOW_MS is the same outage: the count carries on
//    from where it was, so a flapping link cannot re-mint forever. On top of
//    that, one chat gets at most MAX_RECONNECT_MINTS_PER_CHAT reconnect mints.
//    Every mint counts against the shared DAILY_SESSION_CAP, so neither limit
//    is optional.

export const RECONNECT_GRACE_MS = 8_000;
export const MAX_RECONNECT_ATTEMPTS = 3;
/** Wait before attempt 1, 2 and 3. The first is immediate: grace already waited. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [0, 2_000, 4_000];
/** A 429 with no usable wait: do not hammer, do not wait forever. */
export const DEFAULT_COOLDOWN_SECONDS = 15;
/** A new session must stay up this long before the next drop counts as a new outage. */
export const STABILITY_WINDOW_MS = 30_000;
/** Reconnect mints one chat may spend in total, however stable the link was between. */
export const MAX_RECONNECT_MINTS_PER_CHAT = 6;

export type Reconnecting = Extract<ConnectionState, { status: "reconnecting" }>;

/** Why a live link needs a new session now (as opposed to waiting in grace). */
// A closed data channel reaches the machine as "failed": the transport folds it in.
export type LinkDeath = "failed" | "session-expired";

export type ReconnectInput =
  | { type: "link-lost" }
  | { type: "link-recovered" }
  | { type: "link-dead"; cause: LinkDeath }
  /** The browser is back online (or a probe got an answer). */
  | { type: "online" }
  /** The timer the machine asked for has fired. */
  | { type: "timer" }
  | { type: "mint-ok" }
  | { type: "mint-error"; code: FailureCode; retryAfterSeconds?: number }
  | { type: "connect-ok" }
  | { type: "connect-error"; kind: TransportErrorKind };

export type ReconnectEffect =
  | { type: "start-timer"; ms: number }
  | { type: "clear-timer" }
  /** Release the dead transport (not the mic, not the audio element). */
  | { type: "close-transport" }
  /** Whatever was mid-flight on the dead session will never finish. */
  | { type: "settle-items" }
  | { type: "wait-online" }
  | { type: "mint" }
  | { type: "connect" }
  | { type: "recovered" }
  | { type: "fail"; code: FailureCode; retryAfterSeconds?: number };

/**
 * What the machine remembers about a chat across outages. The controller
 * keeps it for the life of the chat and hands it back on every step.
 */
export interface ReconnectLedger {
  /** Reconnect mints spent so far in this chat. */
  mints: number;
  /** When the last rebuilt session came up (ms), or null if none has. */
  stableFrom: number | null;
  /** The attempt number that rebuilt it. */
  lastAttempt: number;
}

export const EMPTY_LEDGER: ReconnectLedger = {
  mints: 0,
  stableFrom: null,
  lastAttempt: 0,
};

export interface ReconnectContext {
  now: number;
  /** navigator.onLine is false, or the last request got no answer. */
  offline: boolean;
  ledger: ReconnectLedger;
}

export interface ReconnectStep {
  /** null = the chat is live again (or was never reconnecting). */
  state: Reconnecting | null;
  effects: ReconnectEffect[];
  /** The ledger after this step. Hand it back with the next input. */
  ledger: ReconnectLedger;
}

const NOTHING = (
  state: Reconnecting | null,
  ctx: ReconnectContext,
): ReconnectStep => ({
  state,
  effects: [],
  ledger: ctx.ledger,
});

/** Errors that mean "stop": retrying cannot help, or would only spend money. */
const TERMINAL_MINT_CODES: ReadonlySet<string> = new Set([
  "voice_disabled",
  "daily_limit",
  "budget_exhausted",
  "doc_not_found",
  "invalid_request",
]);

export function isTerminalMintCode(code: FailureCode): boolean {
  return TERMINAL_MINT_CODES.has(code);
}

function reconnecting(
  prev: Reconnecting | null,
  now: number,
  patch: Pick<Reconnecting, "phase" | "attempt"> & {
    retryAt?: number;
    afterCooldown?: boolean;
  },
): Reconnecting {
  return {
    status: "reconnecting",
    since: prev?.since ?? now,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    ...patch,
  };
}

function fail(
  ctx: ReconnectContext,
  code: FailureCode,
  retryAfterSeconds?: number,
): ReconnectStep {
  return {
    state: null,
    effects: [
      { type: "clear-timer" },
      {
        type: "fail",
        code,
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      },
    ],
    ledger: ctx.ledger,
  };
}

/**
 * The attempt a fresh outage starts at. A drop soon after the last rebuild is
 * the same outage, so it carries on from the attempt that rebuild took; a drop
 * after a stable stretch starts over at 1.
 */
function firstAttempt(ctx: ReconnectContext): number {
  const { stableFrom, lastAttempt } = ctx.ledger;
  return stableFrom !== null && ctx.now - stableFrom < STABILITY_WINDOW_MS
    ? lastAttempt + 1
    : 1;
}

/**
 * Begin attempt `attempt`. `afterCooldown` skips the backoff: the cooldown was
 * the wait. The dead transport is released on the way in; releasing twice is
 * harmless.
 */
function startAttempt(
  prev: Reconnecting | null,
  attempt: number,
  ctx: ReconnectContext,
  afterCooldown = false,
): ReconnectStep {
  if (attempt > MAX_RECONNECT_ATTEMPTS) {
    return fail(ctx, "session_reconnect_failed");
  }
  const head: ReconnectEffect[] = [
    { type: "clear-timer" },
    { type: "close-transport" },
    { type: "settle-items" },
  ];
  if (ctx.offline) {
    return {
      state: reconnecting(prev, ctx.now, {
        phase: "waitingNetwork",
        attempt,
        ...(afterCooldown && { afterCooldown }),
      }),
      effects: [...head, { type: "wait-online" }],
      ledger: ctx.ledger,
    };
  }
  return proceed(prev, attempt, ctx, head, afterCooldown);
}

/** The network is fine: back off if this attempt calls for it, then mint. */
function proceed(
  prev: Reconnecting | null,
  attempt: number,
  ctx: ReconnectContext,
  head: ReconnectEffect[],
  skipBackoff: boolean,
): ReconnectStep {
  // No point waiting out a backoff for a mint that will be refused anyway.
  if (ctx.ledger.mints >= MAX_RECONNECT_MINTS_PER_CHAT) {
    return fail(ctx, "session_reconnect_failed");
  }
  const wait = skipBackoff ? 0 : (RECONNECT_BACKOFF_MS[attempt - 1] ?? 0);
  if (wait === 0) return toMinting(prev, attempt, ctx, head);
  return {
    state: reconnecting(prev, ctx.now, { phase: "backoff", attempt }),
    effects: [...head, { type: "start-timer", ms: wait }],
    ledger: ctx.ledger,
  };
}

/**
 * The one place a reconnect mint is started, so the per-chat budget cannot be
 * bypassed by any route into "minting" (immediate, after backoff, after a
 * cooldown, or after waiting for the network).
 */
function toMinting(
  prev: Reconnecting | null,
  attempt: number,
  ctx: ReconnectContext,
  head: ReconnectEffect[],
): ReconnectStep {
  if (ctx.ledger.mints >= MAX_RECONNECT_MINTS_PER_CHAT) {
    return fail(ctx, "session_reconnect_failed");
  }
  return {
    state: reconnecting(prev, ctx.now, { phase: "minting", attempt }),
    effects: [...head, { type: "mint" }],
    ledger: { ...ctx.ledger, mints: ctx.ledger.mints + 1 },
  };
}

export function reconnectStep(
  state: Reconnecting | null,
  input: ReconnectInput,
  ctx: ReconnectContext,
): ReconnectStep {
  // Live: only a lost or dead link starts anything.
  if (state === null) {
    switch (input.type) {
      case "link-lost":
        return {
          state: reconnecting(null, ctx.now, { phase: "grace", attempt: 0 }),
          effects: [{ type: "start-timer", ms: RECONNECT_GRACE_MS }],
          ledger: ctx.ledger,
        };
      case "link-dead":
        return startAttempt(null, firstAttempt(ctx), ctx);
      case "link-recovered":
      case "online":
      case "timer":
      case "mint-ok":
      case "mint-error":
      case "connect-ok":
      case "connect-error":
        return NOTHING(null, ctx);
      default: {
        const unreachable: never = input;
        return unreachable;
      }
    }
  }

  switch (state.phase) {
    case "grace":
      switch (input.type) {
        case "link-recovered":
          return {
            state: null,
            effects: [{ type: "clear-timer" }, { type: "recovered" }],
            ledger: ctx.ledger,
          };
        case "timer":
        case "link-dead":
          return startAttempt(state, firstAttempt(ctx), ctx);
        case "link-lost":
        case "online":
        case "mint-ok":
        case "mint-error":
        case "connect-ok":
        case "connect-error":
          return NOTHING(state, ctx);
        default: {
          const unreachable: never = input;
          return unreachable;
        }
      }

    case "waitingNetwork":
      // Only the network coming back moves this on. It costs no attempt.
      if (input.type === "online") {
        return proceed(
          state,
          state.attempt,
          { ...ctx, offline: false },
          [],
          // A cooldown that then had to wait for the network was already the wait.
          state.afterCooldown === true,
        );
      }
      return NOTHING(state, ctx);

    case "backoff":
      if (input.type === "timer")
        return toMinting(state, state.attempt, ctx, []);
      return NOTHING(state, ctx);

    case "cooldown":
      if (input.type === "timer") {
        // The wait was the server's, so go straight to the next mint.
        return startAttempt(state, state.attempt + 1, ctx, true);
      }
      return NOTHING(state, ctx);

    case "minting":
      switch (input.type) {
        case "mint-ok":
          return {
            state: reconnecting(state, ctx.now, {
              phase: "connecting",
              attempt: state.attempt,
            }),
            effects: [{ type: "connect" }],
            ledger: ctx.ledger,
          };
        case "mint-error":
          return onMintError(state, input, ctx);
        case "link-lost":
        case "link-recovered":
        case "link-dead":
        case "online":
        case "timer":
        case "connect-ok":
        case "connect-error":
          return NOTHING(state, ctx);
        default: {
          const unreachable: never = input;
          return unreachable;
        }
      }

    case "connecting":
      switch (input.type) {
        case "connect-ok":
          return {
            state: null,
            effects: [{ type: "clear-timer" }, { type: "recovered" }],
            // The stability window starts now, from the attempt that worked.
            ledger: {
              ...ctx.ledger,
              stableFrom: ctx.now,
              lastAttempt: state.attempt,
            },
          };
        case "connect-error":
          // The caller closed it on purpose: nothing to retry.
          if (input.kind === "aborted") return NOTHING(state, ctx);
          if (input.kind === "budget") return fail(ctx, "budget_exhausted");
          return startAttempt(state, state.attempt + 1, ctx);
        case "link-lost":
        case "link-recovered":
        case "link-dead":
        case "online":
        case "timer":
        case "mint-ok":
        case "mint-error":
          return NOTHING(state, ctx);
        default: {
          const unreachable: never = input;
          return unreachable;
        }
      }

    default: {
      const unreachable: never = state.phase;
      return unreachable;
    }
  }
}

function onMintError(
  state: Reconnecting,
  input: Extract<ReconnectInput, { type: "mint-error" }>,
  ctx: ReconnectContext,
): ReconnectStep {
  if (input.code === "rate_limited") {
    const seconds = input.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    // The last attempt has nothing left to resume into: show the plain
    // cooldown with its countdown, as for any other 429.
    if (state.attempt >= MAX_RECONNECT_ATTEMPTS) {
      return fail(ctx, "rate_limited", seconds);
    }
    return {
      state: reconnecting(state, ctx.now, {
        phase: "cooldown",
        attempt: state.attempt,
        retryAt: ctx.now + seconds * 1000,
      }),
      effects: [{ type: "start-timer", ms: seconds * 1000 }],
      ledger: ctx.ledger,
    };
  }
  if (isTerminalMintCode(input.code)) {
    return fail(ctx, input.code, input.retryAfterSeconds);
  }
  return startAttempt(state, state.attempt + 1, ctx);
}
