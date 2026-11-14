export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** "19 s", "5 min", "1 h 12 min". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function coverageLine(coverage: number): string {
  if (coverage >= 1) return "Whole document in context";
  // Floor so "99.6%" never reads as the whole document.
  const percent = Math.max(1, Math.floor(coverage * 100));
  return `First ${percent}% fits in the voice context`;
}
