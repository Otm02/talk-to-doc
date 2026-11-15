import "server-only";
import { isIP } from "node:net";

/**
 * The address a limit is counted against. An IPv4 address stands for one
 * client. An IPv6 customer is handed a whole /64 (2^64 addresses), so keying
 * by the full address would let one machine rotate through a fresh bucket
 * for every request; the /64 prefix is the unit instead.
 */
export function normalizeClientIp(raw: string): string {
  const ip =
    raw
      .trim()
      .replace(/^\[|\]$/g, "")
      .split("%")[0]
      ?.toLowerCase() ?? "";
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return ip || "unknown";

  // ::ffff:203.0.113.9 is an IPv4 client seen through a dual-stack socket.
  const mapped = /^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];

  const groups = expandIpv6(ip);
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** Eight 4-digit hex groups. Assumes `ip` is a valid IPv6 address. */
function expandIpv6(ip: string): string[] {
  const toGroups = (part: string): string[] => {
    if (part === "") return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1] ?? "";
    // A trailing dotted quad is two groups.
    if (last.includes(".")) {
      const [a = 0, b = 0, c = 0, d = 0] = last.split(".").map(Number);
      groups.splice(
        -1,
        1,
        ((a << 8) | b).toString(16),
        ((c << 8) | d).toString(16),
      );
    }
    return groups;
  };
  const [head = "", tail] = ip.split("::");
  const front = toGroups(head);
  const back = tail === undefined ? [] : toGroups(tail);
  const zeros =
    tail === undefined
      ? []
      : Array.from(
          { length: Math.max(0, 8 - front.length - back.length) },
          () => "0",
        );
  return [...front, ...zeros, ...back].map((g) => g.padStart(4, "0"));
}
