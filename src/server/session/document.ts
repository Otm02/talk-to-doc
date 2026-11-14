import "server-only";
import { z } from "zod";
import type { InstructionDocument } from "../context/buildInstructions";
import { catalogError } from "../errors";
import { getState } from "../state";

// What the DocumentStore holds is JSON of unknown provenance (Redis, a TTL,
// possibly an older shape), so it is parsed, not cast.

const Common = {
  title: z.string(),
  context: z.string().min(1),
  coverage: z.number().min(0).max(1),
};

const StoredDocumentSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("pdf"),
    ...Common,
    stats: z.object({ pages: z.number().int().nonnegative() }),
  }),
  z.object({
    sourceType: z.literal("youtube"),
    ...Common,
    // Absent on records written before M5; the instructions simply omit them.
    durationSec: z.number().int().nonnegative().optional(),
    language: z.string().optional(),
  }),
]);

/** Throws doc_not_found when the id is unknown, expired or not a document. */
export async function loadInstructionDocument(
  documentId: string,
): Promise<InstructionDocument> {
  const raw = await getState().documents.get(documentId);
  const parsed = StoredDocumentSchema.safeParse(raw);
  if (!parsed.success) throw catalogError("doc_not_found");
  const doc = parsed.data;
  switch (doc.sourceType) {
    case "pdf":
      return {
        source: "pdf",
        title: doc.title,
        context: doc.context,
        coverage: doc.coverage,
        pages: doc.stats.pages,
      };
    case "youtube":
      return {
        source: "youtube",
        title: doc.title,
        context: doc.context,
        coverage: doc.coverage,
        durationSec: doc.durationSec,
        language: doc.language,
      };
    default: {
      const unreachable: never = doc;
      return unreachable;
    }
  }
}
