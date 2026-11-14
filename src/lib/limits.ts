// Limits the browser checks before it sends anything. The server re-checks
// them: these only save the user a round trip. Server-side limits import from
// here so the two values cannot drift apart.

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
