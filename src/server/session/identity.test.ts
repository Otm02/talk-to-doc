import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  getAnonymousIdentity,
  safetyIdentifier,
  sessionCookieHeader,
} from "./identity";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const req = (cookie?: string) =>
  new Request("https://example.test/", {
    headers: cookie === undefined ? {} : { cookie },
  });

describe("getAnonymousIdentity", () => {
  it("reuses the id in our cookie", () => {
    expect(getAnonymousIdentity(req(`${SESSION_COOKIE}=${ID}`))).toEqual({
      id: ID,
      isNew: false,
    });
  });

  it("finds our cookie among others, with stray spaces", () => {
    const got = getAnonymousIdentity(
      req(`theme=dark; ${SESSION_COOKIE} = ${ID} ;flag`),
    );
    expect(got).toEqual({ id: ID, isNew: false });
  });

  it.each([
    ["no cookie header", undefined],
    ["other cookies only", "a=1; b=2"],
    ["a cookie with no value separator", "junk"],
    ["a forged id", `${SESSION_COOKIE}=../../etc/passwd`],
    ["an id with a newline", `${SESSION_COOKIE}=${ID}%0d%0a`],
    ["an uppercase id", `${SESSION_COOKIE}=${ID.toUpperCase()}`],
  ])("makes a fresh id for %s", (_name, cookie) => {
    const got = getAnonymousIdentity(req(cookie));
    expect(got.isNew).toBe(true);
    expect(got.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(got.id).not.toBe(ID);
  });
});

describe("safetyIdentifier", () => {
  it("is 64 hex characters, stable, and not the cookie id", () => {
    const a = safetyIdentifier({ id: ID, isNew: false });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(safetyIdentifier({ id: ID, isNew: true }));
    expect(a).not.toContain(ID);
    expect(a).toBe(
      createHash("sha256").update(`ttd-safety:${ID}`).digest("hex"),
    );
  });
});

describe("sessionCookieHeader", () => {
  it("is HttpOnly, SameSite=Lax and lasts a year", () => {
    const h = sessionCookieHeader({ id: ID, isNew: true }, false);
    expect(h).toBe(
      `${SESSION_COOKIE}=${ID}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
    );
  });

  it("adds Secure over https", () => {
    expect(sessionCookieHeader({ id: ID, isNew: true }, true)).toMatch(
      /; Secure$/,
    );
  });
});
