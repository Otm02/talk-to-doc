import { z } from "zod";

// Body of a successful POST /api/realtime/session. Shared so the server
// builds it and the browser validates it from one definition. The browser
// never receives anything else about the session: not the instructions, not
// the document, not the key.
export const SessionResponseSchema = z.object({
  clientSecret: z.string().min(1),
  /** Unix seconds, as OpenAI reports it. */
  expiresAt: z.number(),
  model: z.string().min(1),
  /** The chat's length cap (MAX_SESSION_MINUTES), enforced by the client. */
  maxSessionSeconds: z.number().int().positive(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** The shape every route handler uses for errors. */
export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string() }),
});
