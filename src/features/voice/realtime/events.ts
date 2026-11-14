import { z } from "zod";

// Server events we handle, from docs/reference/openai-realtime.md section 3
// (GA names only). Schemas declare just the fields the
// reducer reads; z.object strips the rest, so OpenAI adding a field never
// breaks parsing (and keeps TypeScript able to narrow the union). Anything
// that does not parse becomes a counted diagnostic, never an exception.

const num = z.number();

const TokenDetails = z.object({
  text_tokens: num.optional(),
  audio_tokens: num.optional(),
  image_tokens: num.optional(),
});

export const ResponseUsageSchema = z.object({
  total_tokens: num.optional(),
  input_tokens: num.optional(),
  output_tokens: num.optional(),
  input_token_details: TokenDetails.extend({
    cached_tokens: num.optional(),
    cached_tokens_details: TokenDetails.optional(),
  }).optional(),
  output_token_details: TokenDetails.optional(),
});
export type ResponseUsageWire = z.infer<typeof ResponseUsageSchema>;

// Input transcription is billed by its own model, reported either in tokens
// or in seconds depending on the model (reference section 3).
export const TranscriptionUsageSchema = z.union([
  z.object({
    type: z.literal("tokens"),
    input_tokens: num.optional(),
    output_tokens: num.optional(),
    input_token_details: TokenDetails.optional(),
  }),
  z.object({ type: z.literal("duration"), seconds: num }),
]);
export type TranscriptionUsageWire = z.infer<typeof TranscriptionUsageSchema>;

const ContentPart = z.object({
  type: z.string().optional(),
  text: z.string().nullish(),
  transcript: z.string().nullish(),
});

export const ItemSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  content: z.array(ContentPart).nullish(),
});
export type WireItem = z.infer<typeof ItemSchema>;

const ErrorBody = z.object({
  type: z.string().nullish(),
  code: z.string().nullish(),
  message: z.string().nullish(),
  event_id: z.string().nullish(),
});

const ResponseBody = z.object({
  id: z.string(),
  status: z.string().optional(),
  status_details: z
    .looseObject({
      type: z.string().nullish(),
      reason: z.string().nullish(),
      error: ErrorBody.nullish(),
    })
    .nullish(),
  usage: ResponseUsageSchema.nullish(),
  output: z.array(ItemSchema).nullish(),
});

// Generic so the literal survives and the union can still be narrowed.
const item = <T extends string>(type: T) =>
  z.object({
    type: z.literal(type),
    item: ItemSchema,
    previous_item_id: z.string().nullish(),
  });

const schemas = [
  z.object({ type: z.literal("session.created") }),
  z.object({ type: z.literal("session.updated") }),
  z.object({
    type: z.literal("input_audio_buffer.speech_started"),
    item_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("input_audio_buffer.speech_stopped"),
    item_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("input_audio_buffer.committed"),
    item_id: z.string(),
    previous_item_id: z.string().nullish(),
  }),
  item("conversation.item.added"),
  item("conversation.item.done"),
  z.object({
    type: z.literal("conversation.item.truncated"),
    item_id: z.string(),
  }),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.delta"),
    item_id: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.completed"),
    item_id: z.string(),
    transcript: z.string(),
    usage: TranscriptionUsageSchema.nullish(),
  }),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.failed"),
    item_id: z.string(),
    error: ErrorBody.nullish(),
  }),
  z.object({
    type: z.literal("response.created"),
    response: z.object({ id: z.string() }),
  }),
  z.object({ type: z.literal("response.done"), response: ResponseBody }),
  z.object({
    type: z.literal("response.output_audio_transcript.delta"),
    response_id: z.string(),
    item_id: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("response.output_audio_transcript.done"),
    response_id: z.string(),
    item_id: z.string(),
    transcript: z.string(),
  }),
  z.object({
    type: z.literal("response.output_text.delta"),
    response_id: z.string(),
    item_id: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("response.output_text.done"),
    response_id: z.string(),
    item_id: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("output_audio_buffer.started"),
    response_id: z.string(),
  }),
  z.object({
    type: z.literal("output_audio_buffer.stopped"),
    response_id: z.string(),
  }),
  z.object({
    type: z.literal("output_audio_buffer.cleared"),
    response_id: z.string(),
  }),
  z.object({ type: z.literal("error"), error: ErrorBody }),
] as const;

export const ServerEventSchema = z.discriminatedUnion("type", schemas);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent["type"];

const HANDLED_TYPES: ReadonlySet<string> = new Set(
  schemas.map((s) => s.shape.type.value),
);

// Real events we deliberately do nothing with. Listing them keeps the
// "unknown" counter meaningful: it only moves for events we have never seen.
const IGNORED_TYPES: ReadonlySet<string> = new Set([
  "conversation.created",
  // Beta name: the GA events are item.added and item.done (reference section
  // 7, "do not rely on it"). Ignored, so a server that still sends it cannot
  // add the same item twice or reorder it.
  "conversation.item.created",
  "conversation.item.deleted",
  "conversation.item.retrieved",
  "input_audio_buffer.cleared",
  "input_audio_buffer.timeout_triggered",
  "rate_limits.updated",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  // Carry audio only over WebSocket; on WebRTC they are empty markers.
  "response.output_audio.delta",
  "response.output_audio.done",
]);

export type ParseResult =
  | { kind: "event"; event: ServerEvent }
  | { kind: "ignored"; type: string }
  | { kind: "unknown"; type: string }
  | { kind: "malformed"; type?: string };

/** Never throws, whatever the string holds. */
export function parseServerEvent(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  if (typeof json !== "object" || json === null || !("type" in json)) {
    return { kind: "malformed" };
  }
  const type = json.type;
  if (typeof type !== "string") return { kind: "malformed" };
  if (IGNORED_TYPES.has(type)) return { kind: "ignored", type };
  if (!HANDLED_TYPES.has(type)) return { kind: "unknown", type };
  const parsed = ServerEventSchema.safeParse(json);
  return parsed.success
    ? { kind: "event", event: parsed.data }
    : { kind: "malformed", type };
}
