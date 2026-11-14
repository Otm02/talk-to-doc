import { describe, expect, it } from "vitest";
import { buildCsp, securityHeaders } from "./security-headers";

describe("security headers", () => {
  const csp = buildCsp(false);

  it("allows OpenAI, Blob uploads and blob: media, and nothing framed", () => {
    expect(csp).toContain(
      "connect-src 'self' https://api.openai.com https://*.public.blob.vercel-storage.com",
    );
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("allows YouTube thumbnails and no other remote images", () => {
    expect(csp).toContain("img-src 'self' data: blob: https://i.ytimg.com;");
  });

  it("only allows unsafe-eval and websockets in dev", () => {
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/\bwss?:/);
    expect(buildCsp(true)).toContain("'unsafe-eval'");
  });

  it("sends the other headers", () => {
    const map = new Map(securityHeaders(false).map((h) => [h.key, h.value]));
    expect(map.get("Permissions-Policy")).toContain("microphone=(self)");
    expect(map.get("Strict-Transport-Security")).toContain("max-age=");
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});
