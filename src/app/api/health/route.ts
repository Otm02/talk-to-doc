import { getEnv } from "@/server/env";
import { handle } from "@/server/http";
import pkg from "../../../../package.json";

// No `runtime` export: it is rejected under cacheComponents, and Node is the default.
export const GET = handle(() => {
  const env = getEnv();
  return Response.json(
    {
      ok: true,
      version: env.commitSha ? env.commitSha.slice(0, 7) : pkg.version,
      model: env.realtimeModel,
      uploadMode: env.uploadMode,
      state: env.stateDriver,
    },
    { headers: { "cache-control": "no-store" } },
  );
});
