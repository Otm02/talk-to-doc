import { z } from "zod";

// Shapes that cross the wire for ingestion. No `server-only` import: the
// client validates the same schemas when it reads the NDJSON stream (M4).

export const IngestStatsSchema = z.strictObject({
  pages: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
export type IngestStats = z.infer<typeof IngestStatsSchema>;

/**
 * Stream order is meta, page..., then done or error. Lines are told apart by
 * their keys. Stats and coverage are only known once every page has been read,
 * so they ride on `done`: that is what lets the first page go out in
 * milliseconds instead of after the whole file.
 */
export const MetaLineSchema = z.strictObject({
  documentId: z.string().min(1),
  title: z.string(),
  sourceType: z.literal("pdf"),
  pages: z.number().int().nonnegative(),
});
export const PageLineSchema = z.strictObject({
  page: z.number().int().positive(),
  text: z.string(),
});
export const DoneLineSchema = z.strictObject({
  done: z.literal(true),
  stats: IngestStatsSchema,
  coverage: z.number().min(0).max(1),
});
export const ErrorLineSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});

export const IngestLineSchema = z.union([
  MetaLineSchema,
  PageLineSchema,
  DoneLineSchema,
  ErrorLineSchema,
]);
export type MetaLine = z.infer<typeof MetaLineSchema>;
export type PageLine = z.infer<typeof PageLineSchema>;
export type DoneLine = z.infer<typeof DoneLineSchema>;
export type ErrorLine = z.infer<typeof ErrorLineSchema>;
export type IngestLine = z.infer<typeof IngestLineSchema>;

/** Body of POST /api/ingest/pdf when UPLOAD_MODE=blob. */
export const BlobIngestBodySchema = z.strictObject({
  blobUrl: z.string().min(1).max(2048),
  // Only used as the title when the PDF has none; the browser knows it.
  fileName: z.string().max(255).optional(),
});
export type BlobIngestBody = z.infer<typeof BlobIngestBodySchema>;
