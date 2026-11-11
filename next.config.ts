import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

// No middleware or proxy.ts: Next buffers proxied bodies at 10 MB, which would
// truncate local 25 MB uploads. Headers live here, rate limiting in handlers.
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  allowedDevOrigins: ["*.trycloudflare.com"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env.NODE_ENV !== "production"),
      },
    ];
  },
};

export default nextConfig;
