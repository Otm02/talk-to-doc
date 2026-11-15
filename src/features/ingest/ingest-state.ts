import type {
  DoneLine,
  MetaLine,
  PageLine,
  SegmentLine,
} from "@/lib/wire/ingest";

export type IngestRequest =
  | { kind: "pdf"; file: File }
  // A bundled sample: fetched first, then sent like any other file.
  | { kind: "pdf-sample"; url: string; name: string }
  | { kind: "youtube"; url: string };

export interface DocumentData {
  meta: MetaLine;
  /** The uploaded file's name. Only the browser knows it; a video has none. */
  fileName?: string;
  pages: PageLine[];
  segments: SegmentLine["segment"][];
  done: DoneLine | null;
}

export type IngestState =
  | { status: "idle" }
  | {
      status: "uploading";
      fileName: string;
      size: number;
      percent: number;
      /** No progress for a while: the screen offers Cancel and Keep waiting. */
      stalled: boolean;
    }
  | { status: "extracting"; doc: DocumentData | null }
  | { status: "ready"; doc: DocumentData }
  /** The stream broke after the document began: what arrived is kept. */
  | { status: "partial"; doc: DocumentData; code: string }
  | {
      status: "error";
      code: string;
      retryAfterSeconds?: number;
      /** The same wait as a deadline (ms since epoch), for the countdown. */
      retryAt?: number;
    };

export type IngestAction =
  | { type: "upload-start"; fileName: string; size: number }
  | { type: "upload-progress"; percent: number }
  | { type: "upload-stalled" }
  | { type: "upload-resume" }
  /** The stream broke. With pages in hand they are kept; without, it is a plain failure. */
  | { type: "interrupt"; code: string }
  | { type: "extract-start" }
  /**
   * A load that has no upload step (a link) begins. Unlike extract-start it
   * always leaves what was on screen, so a document that is being loaded again
   * shows as loading instead of staying put with its buttons live.
   */
  | { type: "load-start" }
  | { type: "meta"; meta: MetaLine; fileName?: string }
  | { type: "units"; pages: PageLine[]; segments: SegmentLine["segment"][] }
  | { type: "done"; done: DoneLine }
  | { type: "fail"; code: string; retryAfterSeconds?: number; retryAt?: number }
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
        stalled: false,
      };
    case "upload-progress":
      // Any progress at all means the link is moving again.
      return state.status === "uploading"
        ? { ...state, percent: action.percent, stalled: false }
        : state;
    case "upload-stalled":
      return state.status === "uploading" && !state.stalled
        ? { ...state, stalled: true }
        : state;
    case "upload-resume":
      return state.status === "uploading" && state.stalled
        ? { ...state, stalled: false }
        : state;
    case "interrupt":
      return state.status === "extracting" && state.doc
        ? { status: "partial", doc: state.doc, code: action.code }
        : { status: "error", code: action.code };
    case "load-start":
      return { status: "extracting", doc: null };
    case "extract-start":
      // A late "uploaded" event must not wipe a document that already arrived.
      return state.status === "extracting" || state.status === "ready"
        ? state
        : { status: "extracting", doc: null };
    case "meta":
      return {
        status: "extracting",
        doc: {
          meta: action.meta,
          ...(action.fileName !== undefined && { fileName: action.fileName }),
          pages: [],
          segments: [],
          done: null,
        },
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
        retryAt: action.retryAt,
      };
    case "reset":
      return initialIngestState;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
