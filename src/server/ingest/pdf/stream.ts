import "server-only";
import type {
  DoneLine,
  ErrorLine,
  MetaLine,
  PageLine,
} from "@/lib/wire/ingest";
import { encodeNdjsonLine } from "@/lib/wire/ndjson";
import { capToTokenBudget, countTokens } from "../../context/budget";
import { catalogError, toErrorResult } from "../../errors";
import type { DocumentStore } from "../../state";
import type { PdfDocumentRecord } from "../record";
import type { OpenPdf } from "./extract";
import { MIN_AVG_CHARS_PER_PAGE } from "./limits";
import {
  countVisibleChars,
  countWords,
  normalizePageText,
  pageMarker,
} from "./normalize";

export interface PdfStreamOptions {
  doc: OpenPdf;
  documentId: string;
  title: string;
  store: DocumentStore;
  contextTokenBudget: number;
  ttlMs: number;
  requestId: string;
  now?: () => number;
}

const encoder = new TextEncoder();

/**
 * pdf.js work is a chain of promise callbacks, which never lets the event loop
 * reach the phase that writes to the socket. Without this pause every page of
 * a big file piles up and goes out together at the end; with it, each page is
 * on the wire as soon as it is read.
 */
const flushToNetwork = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * NDJSON body: one meta line, a page line as each page is read, then `done`
 * with the totals, or an `error` line if anything fails after the first byte.
 * Pages are produced in `pull`, so a slow reader slows extraction down instead
 * of buffering a whole document, and a closed connection stops the work.
 */
export function createPdfIngestStream(
  options: PdfStreamOptions,
): ReadableStream<Uint8Array> {
  const { doc, requestId } = options;
  const pages: string[] = [];
  let finished = false;

  const write = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    line: MetaLine | PageLine | DoneLine | ErrorLine,
  ) => controller.enqueue(encoder.encode(encodeNdjsonLine(line)));

  return new ReadableStream<Uint8Array>({
    start(controller) {
      write(controller, {
        documentId: options.documentId,
        title: options.title,
        sourceType: "pdf",
        pages: doc.numPages,
      });
    },

    async pull(controller) {
      if (finished) return;
      try {
        if (pages.length < doc.numPages) {
          const page = pages.length + 1;
          const text = normalizePageText(await doc.readPage(page));
          if (finished) return; // the client left while we were reading
          pages.push(text);
          write(controller, { page, text });
          await flushToNetwork();
          return;
        }
        write(controller, await finalize(options, pages));
        finished = true;
        controller.close();
        await doc.close();
      } catch (err) {
        finished = true;
        // Same mapping as the JSON error path: AppError copy or a generic message.
        const { body } = toErrorResult(err, requestId);
        console.error(`[${requestId}] ${body.error.code}`, err);
        write(controller, { error: body.error });
        controller.close();
        await doc.close();
      }
    },

    async cancel() {
      finished = true;
      await doc.close();
    },
  });
}

/** Runs once every page is in: scan check, totals, budget cut, save. */
async function finalize(
  options: PdfStreamOptions,
  pages: string[],
): Promise<DoneLine> {
  const visibleChars = pages.reduce((n, p) => n + countVisibleChars(p), 0);
  // Zero pages counts as no text too: there is nothing to read either way.
  if (
    pages.length === 0 ||
    visibleChars / pages.length < MIN_AVG_CHARS_PER_PAGE
  ) {
    throw catalogError("pdf_no_text");
  }

  const fullText = pages
    .map((text, i) =>
      text ? `${pageMarker(i + 1)}\n${text}` : pageMarker(i + 1),
    )
    .join("\n\n");
  const tokens = countTokens(fullText);
  const stats = {
    pages: pages.length,
    words: pages.reduce((n, p) => n + countWords(p), 0),
    tokens,
  };
  const coverage = Math.min(
    1,
    options.contextTokenBudget / Math.max(tokens, 1),
  );
  const { text: context } = capToTokenBudget(
    fullText,
    options.contextTokenBudget,
    tokens,
  );

  const record: PdfDocumentRecord = {
    id: options.documentId,
    sourceType: "pdf",
    title: options.title,
    context,
    stats,
    coverage,
    createdAt: (options.now ?? Date.now)(),
  };
  await options.store.put(record.id, record, options.ttlMs);

  return { done: true, stats, coverage };
}
