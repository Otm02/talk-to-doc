import { handle } from "@/server/http";
import { createSession } from "@/server/session/service";

// One OpenAI call with a 10 s timeout plus a store read.
export const maxDuration = 20;

export const POST = handle("session", (req) => createSession(req));
