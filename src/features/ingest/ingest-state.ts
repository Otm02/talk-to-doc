import type { DoneLine, MetaLine, PageLine, SegmentLine } from "@/lib/wire/ingest";

export type IngestRequest =
  | { kind: "pdf"; file: File }
  // A bundled sample: fetched first, then sent like any other file.
  | { kind: "pdf-sample"; url: string; name: string }
  | { kind: "youtube"; url: string };

export interface DocumentData {
  meta: MetaLine;
  pages: PageLine[];
  segments: SegmentLine["segment"][];
  done: DoneLine | null;
}

export type IngestState =
  | { status: "idle" }
  | { status: "uploading"; fileName: string; size: number; percent: number }
  | { status: "extracting"; doc: DocumentData | null }
  | { status: "ready"; doc: DocumentData }
  | { status: "error"; code: string; retryAfterSeconds?: number };

export type IngestAction =
  | { type: "upload-start"; fileName: string; size: number }
  | { type: "upload-progress"; percent: number }
  | { type: "extract-start" }
  | { type: "meta"; meta: MetaLine }
  | { type: "units"; pages: PageLine[]; segments: SegmentLine["segment"][] }
  | { type: "done"; done: DoneLine }
  | { type: "fail"; code: string; retryAfterSeconds?: number }
  | { type: "reset" };

export const initialIngestState: IngestState = { status: "idle" };

export function ingestReducer(
  state: IngestState,
  action: IngestAction,
): IngestState {
  switch (action.type) {
    case "upload-start":
      return {
        status: "uploading",
        fileName: action.fileName,
        size: action.size,
        percent: 0,
      };
    case "upload-progress":
      return state.status === "uploading"
        ? { ...state, percent: action.percent }
        : state;
    case "extract-start":
      // A late "uploaded" event must not wipe a document that already arrived.
      return state.status === "extracting" || state.status === "ready"
        ? state
        : { status: "extracting", doc: null };
    case "meta":
      return {
        status: "extracting",
        doc: { meta: action.meta, pages: [], segments: [], done: null },
      };
    case "units":
      if (state.status !== "extracting" || !state.doc) return state;
      return {
        status: "extracting",
        doc: {
          ...state.doc,
          pages: state.doc.pages.concat(action.pages),
          segments: state.doc.segments.concat(action.segments),
        },
      };
    case "done":
      if (state.status !== "extracting" || !state.doc) return state;
      return { status: "ready", doc: { ...state.doc, done: action.done } };
    case "fail":
      return {
        status: "error",
        code: action.code,
        retryAfterSeconds: action.retryAfterSeconds,
      };
    case "reset":
      return initialIngestState;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
