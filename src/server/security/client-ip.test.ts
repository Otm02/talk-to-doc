import { describe, expect, it } from "vitest";
import { normalizeClientIp } from "./client-ip";

describe("normalizeClientIp", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    [" 203.0.113.9 ", "203.0.113.9"],
    ["unknown", "unknown"],
    ["", "unknown"],
  ])("leaves %j alone", (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });

  it.each([
    ["2001:db8:1:2:3:4:5:6", "2001:0db8:0001:0002::/64"],
    ["2001:DB8:1:2::9", "2001:0db8:0001:0002::/64"],
    ["2001:db8::1", "2001:0db8:0000:0000::/64"],
    ["::1", "0000:0000:0000:0000::/64"],
    ["[2001:db8:1:2::1]", "2001:0db8:0001:0002::/64"],
    ["fe80::1%eth0", "fe80:0000:0000:0000::/64"],
    ["64:ff9b::203.0.113.9", "0064:ff9b:0000:0000::/64"],
  ])("reduces %s to its /64", (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });

  it("gives every address in one /64 the same value", () => {
    const a = normalizeClientIp("2001:db8:aaaa:bbbb:1:2:3:4");
    expect(normalizeClientIp("2001:db8:aaaa:bbbb::")).toBe(a);
    expect(normalizeClientIp("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff")).toBe(a);
    expect(normalizeClientIp("2001:db8:aaaa:bbbc::1")).not.toBe(a);
  });

  it("reads an IPv4-mapped address as IPv4", () => {
    expect(normalizeClientIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("does not throw on junk", () => {
    expect(normalizeClientIp("not an ip at all")).toBe("not an ip at all");
    expect(normalizeClientIp("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });
});
