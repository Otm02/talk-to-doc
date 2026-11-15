import { getEnv } from "@/server/env";
import { handle } from "@/server/http";
import { HEALTH_RATE } from "@/server/security/limits";
import { enforceRateLimit } from "@/server/security/rate-limit";
import pkg from "../../../../package.json";

// Reads two env vars and one rate-limit key.
export const maxDuration = 10;

// No `runtime` export: it is rejected under cacheComponents, and Node is the default.
export const GET = handle("health", async (req) => {
  await enforceRateLimit(req, "health", HEALTH_RATE);
  const env = getEnv();
  return Response.json(
    {
      ok: true,
      version: env.commitSha ? env.commitSha.slice(0, 7) : pkg.version,
      // The browser reads uploadMode to choose how to upload. `state` lets the
      // deploy smoke test see that production is not on per-instance memory.
      // Nothing else about the setup (model, keys, limits) is public.
      uploadMode: env.uploadMode,
      state: env.stateDriver,
    },
    { headers: { "cache-control": "no-store" } },
  );
});
