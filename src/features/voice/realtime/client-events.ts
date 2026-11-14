// Events we send. GA names and shapes from docs/reference/openai-realtime.md
// section 2 and the client-events reference:
//  - conversation.item.create takes a client-chosen item.id.
//  - A text-only reply is response.create { response: { output_modalities } }.
//  - Stopping an answer on WebRTC is response.cancel, then
//    output_audio_buffer.clear (in that order).

export type ClientEvent =
  | {
      type: "conversation.item.create";
      event_id: string;
      item: {
        id: string;
        type: "message";
        role: "user";
        content: Array<{ type: "input_text"; text: string }>;
      };
    }
  | {
      type: "response.create";
      event_id: string;
      response?: { output_modalities: ["text"] };
    }
  | { type: "response.cancel"; event_id: string }
  | { type: "output_audio_buffer.clear"; event_id: string };

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Short random ids: item ids are limited in length, event ids to 512. */
export const newItemId = (): string => `item_${randomHex(10)}`;
export const newEventId = (): string => `evt_${randomHex(10)}`;

export function createTextItem(
  id: string,
  text: string,
  eventId: string,
): ClientEvent {
  return {
    type: "conversation.item.create",
    event_id: eventId,
    item: {
      id,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

/** `textOnly` asks for a text reply even if the session default is audio. */
export function createResponse(
  eventId: string,
  textOnly: boolean,
): ClientEvent {
  return textOnly
    ? {
        type: "response.create",
        event_id: eventId,
        response: { output_modalities: ["text"] },
      }
    : { type: "response.create", event_id: eventId };
}

export const cancelResponse = (eventId: string): ClientEvent => ({
  type: "response.cancel",
  event_id: eventId,
});

export const clearOutputAudio = (eventId: string): ClientEvent => ({
  type: "output_audio_buffer.clear",
  event_id: eventId,
});
