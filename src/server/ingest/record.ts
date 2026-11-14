import "server-only";
import type { IngestStats, YoutubeStats } from "@/lib/wire/ingest";

/**
 * What the DocumentStore keeps. `context` is the text cut at the token budget;
 * the full text is never stored server-side (the browser already has it from
 * the stream). A `type` alias, not an interface, so it is assignable to the
 * store's JSON value type.
 */
export type PdfDocumentRecord = {
  id: string;
  sourceType: "pdf";
  title: string;
  context: string;
  stats: IngestStats;
  coverage: number;
  createdAt: number;
};

/** The YouTube equivalent: `context` is the [mm:ss] transcript cut at the budget. */
export type YoutubeDocumentRecord = {
  id: string;
  sourceType: "youtube";
  videoId: string;
  title: string;
  context: string;
  stats: YoutubeStats;
  coverage: number;
  createdAt: number;
};
