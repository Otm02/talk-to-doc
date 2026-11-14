// Dev-only event recorder: keeps every server and client event of a session
// and exports them as JSONL, to build golden fixtures from real runs. The
// session's instructions hold the document and the system rules, so they are
// redacted before anything is stored.

export type RecordedDirection = "in" | "out" | "meta";

export interface RecordedEntry {
  /** Milliseconds since the recorder was created. */
  t: number;
  dir: RecordedDirection;
  data: unknown;
}

const MAX_ENTRIES = 20_000;
const REVOKE_DELAY_MS = 10_000;
// Real events nest a handful of levels. Anything deeper is replaced, never
// passed through, so a redaction can not be skipped by burying the value.
const MAX_DEPTH = 32;
// Client secrets never travel on the data channel, but never keep one,
// wherever it sits in a string.
const SECRET = /ek_[A-Za-z0-9_-]{6,}/g;

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET, "[redacted secret]");
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[truncated: nested too deeply]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      k === "instructions" && typeof v === "string"
        ? `[redacted ${v.length} chars]`
        : redact(v, depth + 1);
  }
  return out;
}

export class EventRecorder {
  private entries: RecordedEntry[] = [];
  private dropped = 0;
  private readonly start: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.start = now();
  }

  get size(): number {
    return this.entries.length;
  }

  /** A raw string from the data channel, exactly as received. */
  recordIn(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { unparsed: raw.slice(0, 2000) };
    }
    this.push("in", data);
  }

  /** A client event we sent. */
  recordOut(event: unknown): void {
    this.push("out", event);
  }

  /** Context for whoever reads the file: mode, model, notes. */
  recordMeta(data: Record<string, unknown>): void {
    this.push("meta", data);
  }

  clear(): void {
    this.entries = [];
    this.dropped = 0;
  }

  toJsonl(): string {
    const lines = this.entries.map((e) => JSON.stringify(e));
    if (this.dropped > 0) {
      lines.push(
        JSON.stringify({
          t: this.now() - this.start,
          dir: "meta",
          data: { dropped: this.dropped },
        }),
      );
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }

  /** Browser only: saves the log as a file. */
  download(filename = `realtime-session-${this.start}.jsonl`): void {
    const url = URL.createObjectURL(
      new Blob([this.toJsonl()], { type: "application/x-ndjson" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Safari (iOS especially) starts the download after click() returns;
    // revoking at once can cancel it.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }

  private push(dir: RecordedDirection, data: unknown): void {
    if (this.entries.length >= MAX_ENTRIES) {
      this.dropped += 1;
      return;
    }
    this.entries.push({ t: this.now() - this.start, dir, data: redact(data) });
  }
}

/** Parses a recorded log back into entries; bad lines are skipped. */
export function parseJsonl(text: string): RecordedEntry[] {
  const out: RecordedEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (
        typeof v === "object" &&
        v !== null &&
        "t" in v &&
        "dir" in v &&
        typeof v.t === "number" &&
        (v.dir === "in" || v.dir === "out" || v.dir === "meta")
      ) {
        out.push({ t: v.t, dir: v.dir, data: "data" in v ? v.data : null });
      }
    } catch {
      // A truncated last line from an interrupted download is not fatal.
    }
  }
  return out;
}
