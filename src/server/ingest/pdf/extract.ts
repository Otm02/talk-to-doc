import "server-only";
import { getDocumentProxy, getMeta } from "unpdf";
import { AppError, catalogError } from "../../errors";
import { createSemaphore } from "./concurrency";
import { MAX_CONCURRENT_EXTRACTIONS, MAX_PDF_PAGES } from "./limits";

/** At most N extractions per instance; see concurrency.ts for why this is per process. */
export const extractionSlots = createSemaphore(MAX_CONCURRENT_EXTRACTIONS);

export interface OpenPdf {
  numPages: number;
  /** Raw /Title from the PDF metadata, if any. Not yet cleaned. */
  title: string | undefined;
  /** Text of one page, 1-based, before normalization. */
  readPage(page: number): Promise<string>;
  /** Frees the parser and the concurrency slot. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Maps pdf.js failures by exception name. The classes live inside unpdf's
 * bundled pdf.js, so `instanceof` is not available; the names are stable.
 */
export function mapPdfError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  switch (errorName(err)) {
    case "PasswordException":
      return catalogError("pdf_encrypted", { cause: err });
    case "InvalidPDFException":
    case "FormatError":
      return catalogError("pdf_corrupted", { cause: err });
    default:
      return catalogError("pdf_unreadable", { cause: err });
  }
}

function errorName(err: unknown): string {
  return typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof err.name === "string"
    ? err.name
    : "";
}

/** Throws pdf_timeout if the deadline has passed, so no new work starts after it. */
function ensureTimeLeft(deadline: number): void {
  if (Date.now() >= deadline) throw catalogError("pdf_timeout");
}

/** Fails with pdf_timeout if `promise` has not settled by `deadline` (epoch ms). */
export function raceDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    promise.catch(() => undefined);
    return Promise.reject(catalogError("pdf_timeout"));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(catalogError("pdf_timeout")), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface PositionedLine {
  text: string;
  /** Baseline y in PDF space (grows upward), when pdf.js gave one. */
  y: number | undefined;
}

/**
 * Joins pdf.js text items into page text. pdf.js marks line ends but never
 * emits a blank line, so paragraph breaks are recovered from the vertical gap:
 * a gap over 1.5x the page's typical line spacing becomes a blank line.
 */
export function joinTextItems(items: readonly object[]): string {
  const lines: PositionedLine[] = [];
  let current: PositionedLine | undefined;
  for (const item of items) {
    if (!("str" in item) || typeof item.str !== "string") continue; // marked-content marker
    current ??= { text: "", y: baselineOf(item) };
    current.text += item.str;
    if ("hasEOL" in item && item.hasEOL === true) {
      lines.push(current);
      current = undefined;
    }
  }
  if (current) lines.push(current);

  const visible = lines.filter((line) => line.text.trim() !== "");
  const gaps: number[] = [];
  for (let i = 1; i < visible.length; i++) {
    const gap = gapBetween(visible[i - 1], visible[i]);
    if (gap !== undefined) gaps.push(gap);
  }
  const typical = median(gaps);

  let out = "";
  visible.forEach((line, i) => {
    if (i > 0) {
      const gap = gapBetween(visible[i - 1], line);
      const isParagraph =
        gap !== undefined && typical !== undefined && gap > typical * 1.5;
      out += isParagraph ? "\n\n" : "\n";
    }
    out += line.text;
  });
  return out;
}

function baselineOf(item: object): number | undefined {
  if (!("transform" in item) || !Array.isArray(item.transform))
    return undefined;
  const y: unknown = item.transform[5];
  return typeof y === "number" && Number.isFinite(y) ? y : undefined;
}

/** How far down the page the next line is. Undefined when it jumps up (a new column). */
function gapBetween(
  above: PositionedLine | undefined,
  below: PositionedLine | undefined,
): number | undefined {
  if (above?.y === undefined || below?.y === undefined) return undefined;
  const gap = above.y - below.y;
  return gap > 0 ? gap : undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Opens a PDF for page-by-page reading.
 *
 * `bytes` is copied into a fresh plain Uint8Array first. pdf.js refuses a Node
 * Buffer outright (which is what reading a Blob download produces), and it
 * detaches the buffer it is given, which for a pooled Buffer would pull the
 * rug from under unrelated code. The copy costs a few milliseconds at 25 MB.
 *
 * Pages are read one at a time rather than with unpdf's extractText, which
 * runs every page at once. On the 120-page 18 MB sample that took 4.3 s
 * against 2.5 s sequentially, and one call cannot be interrupted at a deadline
 * or stream its first page early.
 */
export async function openPdf(
  bytes: Uint8Array,
  deadline: number,
): Promise<OpenPdf> {
  const release = await extractionSlots.acquire(deadline);
  let closed = false;
  let destroy: () => Promise<void> = async () => undefined;

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await destroy();
    } catch {
      // Already torn down; nothing to report.
    } finally {
      release();
    }
  };

  try {
    // verbosity 0: errors only, so pdf.js does not log warnings about the
    // document's content. SPEC T-09 asked for isEvalSupported: false; this
    // pdf.js build no longer has an eval path or the option.
    const opening = getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    // If we give up waiting, still free the parser when it finally opens.
    opening.then(
      (late) => {
        if (closed) void late.loadingTask.destroy().catch(() => undefined);
      },
      () => undefined,
    );
    const pdf = await raceDeadline(opening, deadline);
    destroy = () => pdf.loadingTask.destroy();

    if (pdf.numPages > MAX_PDF_PAGES) throw catalogError("pdf_too_many_pages");

    const title = await readTitle(pdf);
    return {
      numPages: pdf.numPages,
      title,
      async readPage(page) {
        try {
          ensureTimeLeft(deadline);
          const handle = await raceDeadline(pdf.getPage(page), deadline);
          try {
            ensureTimeLeft(deadline);
            const content = await raceDeadline(
              handle.getTextContent(),
              deadline,
            );
            return joinTextItems(content.items);
          } finally {
            handle.cleanup();
          }
        } catch (err) {
          throw mapPdfError(err);
        }
      },
      close,
    };
  } catch (err) {
    await close();
    throw mapPdfError(err);
  }
}

async function readTitle(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<string | undefined> {
  try {
    const { info } = await getMeta(pdf);
    return typeof info.Title === "string" ? info.Title : undefined;
  } catch {
    return undefined; // a bad Info dictionary should not fail the whole upload
  }
}
