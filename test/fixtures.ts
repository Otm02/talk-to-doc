import { readFileSync } from "node:fs";
import path from "node:path";

/** A fresh copy every call, so one test can never change another's input. */
export function pdfFixture(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    readFileSync(path.join(import.meta.dirname, "fixtures", "pdf", name)),
  );
}
