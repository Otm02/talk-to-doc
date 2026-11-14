import "server-only";
import type { TranscriptProviderName } from "@/lib/wire/ingest";
import type { Env } from "../../env";
import { createDirectProvider } from "./direct";
import { DIRECT_FAST_FAIL_MS, DIRECT_TIMEOUT_MS } from "./limits";
import { createSupadataProvider } from "./supadata";
import {
  TranscriptError,
  isRetryable,
  type Transcript,
  type TranscriptErrorCode,
  type TranscriptProvider,
} from "./provider";

export type Attempt = {
  provider: TranscriptProviderName;
  code: TranscriptErrorCode;
};

export type ChainResult = {
  transcript: Transcript;
  /** The provider that served it. */
  provider: TranscriptProviderName;
  /** Providers that failed first, for the log line. */
  attempts: Attempt[];
};

export interface TranscriptChain {
  fetch(
    videoId: string,
    preferredLang: string,
    signal: AbortSignal,
  ): Promise<ChainResult>;
}

/**
 * Tries providers in order. Only BLOCKED, UPSTREAM_TIMEOUT and UPSTREAM_FAILED
 * move on to the next: those say something about the provider, not the video.
 * "No captions" or "age-restricted" would come back the same from the next one
 * (and cost a Supadata credit to find out), so they stop the chain. When every
 * provider fails, the last error is the one the user sees.
 */
export function createChain(
  providers: readonly TranscriptProvider[],
): TranscriptChain {
  return {
    async fetch(videoId, preferredLang, signal) {
      const attempts: Attempt[] = [];
      let last: TranscriptError | undefined;

      for (const provider of providers) {
        try {
          const transcript = await provider.fetch(
            videoId,
            preferredLang,
            signal,
          );
          return { transcript, provider: provider.name, attempts };
        } catch (err) {
          // The client left: stop, and do not try (or bill) anyone else.
          if (signal.aborted) throw err;
          // A provider bug is still a provider problem, not the video's.
          const error =
            err instanceof TranscriptError
              ? err
              : new TranscriptError("UPSTREAM_FAILED", { cause: err });
          if (!isRetryable(error.code)) throw error;
          attempts.push({ provider: provider.name, code: error.code });
          last = error;
        }
      }
      throw last ?? new TranscriptError("UPSTREAM_FAILED");
    },
  };
}

/**
 * Direct first, Supadata behind it when a key is configured. Reads nothing
 * itself: the caller passes the validated env.
 *
 * On Vercel, YouTube mostly blocks us, so with a fallback the direct attempt
 * gets 3 s instead of 15 s. Without a fallback there is nothing to fail over
 * to, so it keeps the longer budget. Retries are for flaky home networks only.
 */
export function buildProviders(
  env: Pick<Env, "supadataApiKey" | "onVercel">,
): TranscriptProvider[] {
  const supadata = env.supadataApiKey
    ? createSupadataProvider({ apiKey: env.supadataApiKey })
    : undefined;
  const direct = createDirectProvider({
    timeoutMs:
      env.onVercel && supadata ? DIRECT_FAST_FAIL_MS : DIRECT_TIMEOUT_MS,
    networkRetries: env.onVercel ? 0 : 1,
  });
  return supadata ? [direct, supadata] : [direct];
}
