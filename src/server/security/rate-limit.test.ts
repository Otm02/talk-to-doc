import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../env";
import { createMemoryAdapters } from "../state/memory";
import type { StateAdapters } from "../state";

const holder = vi.hoisted(() => ({
  state: undefined as StateAdapters | undefined,
}));
vi.mock("../state", () => ({
  getState: () => {
    if (!holder.state) throw new Error("test state not set");
    return holder.state;
  },
}));

import { clientKey, enforceRateLimit } from "./rate-limit";

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", { method: "POST", headers });

beforeEach(() => {
  holder.state = createMemoryAdapters();
});

describe("clientKey", () => {
  beforeEach(() => {
    vi.stubEnv("IP_HASH_SALT", "test-salt-0123456789abcdef");
    resetEnvCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  });

  it("hashes the first forwarded address", () => {
    const a = clientKey(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("203");
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.9" }))).toBe(a);
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.10" }))).not.toBe(a);
  });

  it("falls back to x-real-ip, then to a shared bucket", () => {
    expect(clientKey(req({ "x-real-ip": "198.51.100.1" }))).toBe(
      clientKey(req({ "x-forwarded-for": "198.51.100.1" })),
    );
    expect(clientKey(req())).toBe(clientKey(req()));
  });

  it("is keyed: the same address under another salt is another key, and a plain hash does not match", () => {
    const ip = "203.0.113.9";
    const withSalt = clientKey(req({ "x-forwarded-for": ip }));
    const plain = createHash("sha256").update(ip).digest("hex").slice(0, 16);
    expect(withSalt).not.toBe(plain);

    vi.stubEnv("IP_HASH_SALT", "another-salt-0123456789ab");
    resetEnvCacheForTests();
    expect(clientKey(req({ "x-forwarded-for": ip }))).not.toBe(withSalt);
  });

  it("counts a whole IPv6 /64 as one client, and a different /64 as another", () => {
    const a = clientKey(req({ "x-forwarded-for": "2001:db8:1:2:aaaa::1" }));
    expect(
      clientKey(req({ "x-forwarded-for": "2001:db8:1:2:bbbb:cccc:dddd:eeee" })),
    ).toBe(a);
    expect(clientKey(req({ "x-forwarded-for": "2001:db8:1:3::1" }))).not.toBe(
      a,
    );
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 client", () => {
    expect(clientKey(req({ "x-forwarded-for": "::ffff:203.0.113.9" }))).toBe(
      clientKey(req({ "x-forwarded-for": "203.0.113.9" })),
    );
  });
});

describe("enforceRateLimit", () => {
  const rule = { max: 2, windowMs: 60_000 };
  const ip = { "x-forwarded-for": "203.0.113.9" };

  it("allows up to the limit, then throws rate_limited with Retry-After", async () => {
    await enforceRateLimit(req(ip), "t", rule);
    await enforceRateLimit(req(ip), "t", rule);
    const err = await enforceRateLimit(req(ip), "t", rule).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: "rate_limited",
      httpStatus: 429,
      userMessage: "Too many tries. Try again when the timer ends.",
    });
    const retry = (err as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
  });

  it("counts each client and each scope separately", async () => {
    await enforceRateLimit(req(ip), "a", rule);
    await enforceRateLimit(req(ip), "a", rule);
    await expect(enforceRateLimit(req(ip), "b", rule)).resolves.toBeUndefined();
    await expect(
      enforceRateLimit(req({ "x-forwarded-for": "203.0.113.77" }), "a", rule),
    ).resolves.toBeUndefined();
  });
});
