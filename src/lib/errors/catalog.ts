// Wire codes, HTTP statuses and user-facing copy. Copy comes from docs/SPEC.md
// section 4; it is always this text, never an upstream message. Shared by the
// server (to build errors) and the client (to render them). Entries are added
// per milestone: PDF and upload errors, then YouTube (M3).

export const ERROR_CATALOG = {
  invalid_request: {
    status: 400,
    message: "Something was wrong with that request. Reload and try again.",
  },
  internal: {
    status: 500,
    message: "Something went wrong on our side. Try again.",
  },
  rate_limited: {
    status: 429,
    message: "Too many tries. Wait a minute and try again.",
  },
  pdf_too_large: {
    status: 413,
    message: "This PDF is over 25 MB. Try a smaller file.",
  },
  pdf_empty: { status: 400, message: "This file is empty." },
  pdf_not_pdf: {
    status: 415,
    message: "This file isn't a PDF. Choose a .pdf file.",
  },
  pdf_encrypted: {
    status: 422,
    message:
      "This PDF is password-protected. Remove the password and try again.",
  },
  pdf_corrupted: {
    status: 422,
    message: "We couldn't open this PDF. It may be damaged.",
  },
  // Not in SPEC §4.1 yet: the catch-all for pdf.js failures that are neither
  // a password nor a damaged file.
  pdf_unreadable: {
    status: 422,
    message: "We couldn't read this PDF. Try a different file.",
  },
  pdf_no_text: {
    status: 422,
    message:
      "This PDF has no selectable text. It may be a scan. Try a PDF with real text.",
  },
  pdf_too_many_pages: {
    status: 422,
    message: "This PDF has more than 2,000 pages. Try a shorter one.",
  },
  pdf_timeout: {
    status: 504,
    message: "This PDF took too long to read. Try a smaller file.",
  },
  upload_rejected: {
    status: 400,
    message: "This upload wasn't allowed. Try again.",
  },
  upload_missing: {
    status: 404,
    message: "We couldn't find your upload. Upload it again.",
  },
  youtube_bad_url: {
    status: 400,
    message: "That doesn't look like a YouTube video link.",
  },
  youtube_no_video_id: {
    status: 400,
    message: "That link is a playlist or channel. Paste a link to one video.",
  },
  youtube_no_transcript: {
    status: 422,
    message:
      "This video has no captions, so there's nothing to read. Try another video.",
  },
  youtube_unavailable: {
    status: 404,
    message:
      "This video is unavailable. It may be private, removed or blocked in some regions.",
  },
  youtube_age_restricted: {
    status: 422,
    message:
      "This video is age-restricted, so its captions can't be read. Try another video.",
  },
  youtube_live: {
    status: 422,
    message: "Live streams aren't supported. Try again after the stream ends.",
  },
  youtube_too_long: {
    status: 422,
    message: "This transcript is too long to load. Try a shorter video.",
  },
  youtube_blocked: {
    status: 503,
    message: "YouTube is blocking our server right now. Try again in a minute.",
  },
  youtube_quota: {
    status: 503,
    message:
      "We've used up our YouTube lookups for now. Try a PDF, or try again later.",
  },
  youtube_failed: {
    status: 502,
    message: "We couldn't load this video's captions. Try again.",
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type CatalogCode = keyof typeof ERROR_CATALOG;
