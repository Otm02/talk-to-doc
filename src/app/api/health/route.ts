import { getEnv } from "@/server/env";
import { handle } from "@/server/http";
import { HEALTH_RATE } from "@/server/security/limits";
import { enforceRateLimit } from "@/server/security/rate-limit";
import pkg from "../../../../package.json";

// No `runtime` export: it is rejected under cacheComponents, and Node is the default.
export const GET = handle("health", async (req) => {
  await enforceRateLimit(req, "health", HEALTH_RATE);
  const env = getEnv();
  return Response.json(
    {
      ok: true,
      version: env.commitSha ? env.commitSha.slice(0, 7) : pkg.version,
      // The browser reads this to choose how to upload. Nothing else about the
      // setup (model, storage) is public.
      uploadMode: env.uploadMode,
    },
    { headers: { "cache-control": "no-store" } },
  );
});
