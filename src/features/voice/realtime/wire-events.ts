// Builders for server events as they appear on the wire. Used by the mock
// transport's scenarios and by the tests, so both speak the same shapes.
// Shapes follow docs/reference/openai-realtime.md section 3.

export type Json = Record<string, unknown>;

export const ev = {
  sessionCreated: (): Json => ({ type: "session.created", session: {} }),
  speechStarted: (itemId: string): Json => ({
    type: "input_audio_buffer.speech_started",
    item_id: itemId,
    audio_start_ms: 0,
  }),
  speechStopped: (itemId: string): Json => ({
    type: "input_audio_buffer.speech_stopped",
    item_id: itemId,
    audio_end_ms: 1000,
  }),
  committed: (itemId: string, prev: string | null): Json => ({
    type: "input_audio_buffer.committed",
    item_id: itemId,
    previous_item_id: prev,
  }),
  userAdded: (id: string, prev: string | null): Json => ({
    type: "conversation.item.added",
    previous_item_id: prev,
    item: {
      id,
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "input_audio", transcript: null }],
    },
  }),
  userTextAdded: (id: string, text: string, prev: string | null): Json => ({
    type: "conversation.item.added",
    previous_item_id: prev,
    item: {
      id,
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "input_text", text }],
    },
  }),
  assistantAdded: (id: string, prev: string | null): Json => ({
    type: "conversation.item.added",
    previous_item_id: prev,
    item: {
      id,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  }),
  assistantDone: (
    id: string,
    prev: string | null,
    transcript?: string,
    status = "completed",
  ): Json => ({
    type: "conversation.item.done",
    previous_item_id: prev,
    item: {
      id,
      type: "message",
      role: "assistant",
      status,
      content: transcript ? [{ type: "output_audio", transcript }] : [],
    },
  }),
  transcriptionDelta: (itemId: string, delta: string): Json => ({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: itemId,
    content_index: 0,
    delta,
  }),
  transcriptionDone: (
    itemId: string,
    transcript: string,
    usage?: Json,
  ): Json => ({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    content_index: 0,
    transcript,
    ...(usage ? { usage } : {}),
  }),
  transcriptionFailed: (itemId: string): Json => ({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: itemId,
    content_index: 0,
    error: { type: "server_error", code: "audio_unintelligible", message: "x" },
  }),
  responseCreated: (id: string): Json => ({
    type: "response.created",
    response: { id, status: "in_progress" },
  }),
  responseDone: (
    id: string,
    opts: {
      status?: string;
      reason?: string;
      outputIds?: string[];
      usage?: Json;
      error?: Json;
    } = {},
  ): Json => ({
    type: "response.done",
    response: {
      id,
      status: opts.status ?? "completed",
      status_details: opts.reason
        ? { type: opts.status ?? "cancelled", reason: opts.reason }
        : opts.error
          ? { type: "failed", error: opts.error }
          : null,
      output: (opts.outputIds ?? []).map((oid) => ({
        id: oid,
        type: "message",
        role: "assistant",
        content: [],
      })),
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
  }),
  audioDelta: (rid: string, itemId: string, delta: string): Json => ({
    type: "response.output_audio_transcript.delta",
    response_id: rid,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta,
  }),
  audioTranscriptDone: (
    rid: string,
    itemId: string,
    transcript: string,
  ): Json => ({
    type: "response.output_audio_transcript.done",
    response_id: rid,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    transcript,
  }),
  textDelta: (rid: string, itemId: string, delta: string): Json => ({
    type: "response.output_text.delta",
    response_id: rid,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta,
  }),
  textDone: (rid: string, itemId: string, text: string): Json => ({
    type: "response.output_text.done",
    response_id: rid,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  }),
  audioStarted: (rid: string): Json => ({
    type: "output_audio_buffer.started",
    response_id: rid,
  }),
  audioStopped: (rid: string): Json => ({
    type: "output_audio_buffer.stopped",
    response_id: rid,
  }),
  audioCleared: (rid: string): Json => ({
    type: "output_audio_buffer.cleared",
    response_id: rid,
  }),
  error: (
    code: string,
    eventId?: string,
    type = "invalid_request_error",
  ): Json => ({
    type: "error",
    error: {
      type,
      code,
      message: "upstream words",
      ...(eventId ? { event_id: eventId } : {}),
    },
  }),
};
