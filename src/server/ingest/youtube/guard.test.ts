import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter } from "../../state/memory";
import { createSupadataGuard } from "./guard";
import { SUPADATA_DAILY_CAP } from "./limits";
import { TranscriptError } from "./provider";

describe("createSupadataGuard", () => {
  it("allows the day's share, then refuses with PROVIDER_QUOTA", async () => {
    const guard = createSupadataGuard(createMemoryRateLimiter());
    for (let i = 0; i < SUPADATA_DAILY_CAP; i++) {
      await expect(guard()).resolves.toBeUndefined();
    }
    const err = await guard().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptError);
    expect(err).toMatchObject({ code: "PROVIDER_QUOTA" });
  });

  it("allows 15 lookups a day", () => {
    expect(SUPADATA_DAILY_CAP).toBe(15);
  });

  it("starts again on the next UTC day", async () => {
    let now = Date.UTC(2026, 10, 15, 23, 0, 0);
    const guard = createSupadataGuard(
      createMemoryRateLimiter({ now: () => now }),
    );
    for (let i = 0; i < SUPADATA_DAILY_CAP; i++) await guard();
    await expect(guard()).rejects.toMatchObject({ code: "PROVIDER_QUOTA" });
    now += 2 * 60 * 60 * 1000;
    await expect(guard()).resolves.toBeUndefined();
  });
});
