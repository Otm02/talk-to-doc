/**
 * Generates the PDF fixtures in test/fixtures/pdf. Run with `pnpm fixtures`.
 *
 * Dependency-free on purpose: the PDFs are written by hand (uncompressed, no
 * timestamps, no randomness), so the output is byte-for-byte reproducible and
 * a test can check the committed files are still what this script produces.
 * Node 24 runs this file directly, so keep to erasable TypeScript syntax.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const enc = new TextEncoder();
const at = (a: Uint8Array, i: number): number => a[i] ?? 0;

// --- Text encoding -----------------------------------------------------------

// Latin ligatures are not in WinAnsi, so the font maps codes 1-5 to them with
// /Differences. pdf.js then reports the Unicode ligature, as real PDFs do.
const LIGATURES: Record<string, number> = {
  ﬁ: 1, // fi
  ﬂ: 2, // fl
  ﬀ: 3, // ff
  ﬃ: 4, // ffi
  ﬄ: 5, // ffl
};

// cp1252 code points above 0x7F that differ from Latin-1.
const CP1252: Record<string, number> = {
  œ: 0x9c, // oe ligature
  Œ: 0x8c,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "—": 0x97,
};

/** Escapes a string as a PDF literal string, non-ASCII as octal so the file stays ASCII. */
function literal(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = LIGATURES[ch] ?? CP1252[ch] ?? ch.codePointAt(0) ?? 0x3f;
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e)
      out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(code);
  }
  return `(${out})`;
}

// --- PDF writer --------------------------------------------------------------

type PdfObject =
  | { kind: "plain"; body: string }
  | { kind: "stream"; dict: string; data: Uint8Array };

class PdfWriter {
  private objects: (PdfObject | undefined)[] = [];

  /** Reserves an object number so earlier objects can point at it. */
  reserve(): number {
    this.objects.push(undefined);
    return this.objects.length;
  }
  set(num: number, object: PdfObject): void {
    this.objects[num - 1] = object;
  }
  add(object: PdfObject): number {
    const num = this.reserve();
    this.set(num, object);
    return num;
  }
  get count(): number {
    return this.objects.length;
  }

  finish(opts: {
    root: number;
    info?: number;
    encrypt?: { object: number; id: Uint8Array; streamCipher: StreamCipher };
  }): Uint8Array<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    const push = (c: Uint8Array | string) => {
      const bytes = typeof c === "string" ? enc.encode(c) : c;
      chunks.push(bytes);
      offset += bytes.length;
    };
    push("%PDF-1.4\n");

    const offsets: number[] = [];
    this.objects.forEach((object, i) => {
      const num = i + 1;
      if (!object) throw new Error(`object ${num} was reserved but never set`);
      offsets.push(offset);
      if (object.kind === "plain") {
        push(`${num} 0 obj\n${object.body}\nendobj\n`);
        return;
      }
      const data = opts.encrypt
        ? opts.encrypt.streamCipher(num, object.data)
        : object.data;
      push(
        `${num} 0 obj\n<< ${object.dict} /Length ${data.length} >>\nstream\n`,
      );
      push(data);
      push("\nendstream\nendobj\n");
    });

    const xrefAt = offset;
    push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`);
    for (const o of offsets) push(`${String(o).padStart(10, "0")} 00000 n \n`);
    let trailer = `<< /Size ${this.objects.length + 1} /Root ${opts.root} 0 R`;
    if (opts.info) trailer += ` /Info ${opts.info} 0 R`;
    if (opts.encrypt) {
      const id = hex(opts.encrypt.id);
      trailer += ` /Encrypt ${opts.encrypt.object} 0 R /ID [<${id}> <${id}>]`;
    }
    push(`trailer\n${trailer} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

// --- Standard security handler, RC4 40-bit (PDF 1.4, revision 2) -------------

type StreamCipher = (objectNumber: number, data: Uint8Array) => Uint8Array;

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + at(s, i) + at(key, i % key.length)) & 255;
    const t = at(s, i);
    s[i] = at(s, j);
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255;
    b = (b + at(s, a)) & 255;
    const t = at(s, a);
    s[a] = at(s, b);
    s[b] = t;
    out[n] = at(data, n) ^ at(s, (at(s, a) + at(s, b)) & 255);
  }
  return out;
}

const PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff,
  0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const md5 = (...parts: Uint8Array[]): Uint8Array =>
  new Uint8Array(createHash("md5").update(Buffer.concat(parts)).digest());

const padPassword = (pw: string): Uint8Array =>
  Buffer.concat([Buffer.from(pw, "latin1"), PASSWORD_PAD]).subarray(0, 32);

const FIXED_ID = Uint8Array.from({ length: 16 }, (_, i) => i * 17);

/** Algorithms 2-4 of the PDF 1.7 spec (section 7.6.3) for revision 2. */
function standardEncryption(userPassword: string, ownerPassword: string) {
  const permissions = -3904; // print and copy off, as typical "owner restricted" files
  const owner = rc4(
    md5(padPassword(ownerPassword)).subarray(0, 5),
    padPassword(userPassword),
  );
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const fileKey = md5(padPassword(userPassword), owner, p, FIXED_ID).subarray(
    0,
    5,
  );
  const user = rc4(fileKey, PASSWORD_PAD);
  const streamCipher: StreamCipher = (num, data) =>
    rc4(
      md5(
        fileKey,
        Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]),
      ).subarray(0, 10),
      data,
    );
  return {
    streamCipher,
    dict: `<< /Filter /Standard /V 1 /R 2 /O <${hex(owner)}> /U <${hex(user)}> /P ${permissions} >>`,
  };
}

// --- Documents ---------------------------------------------------------------

type PageSpec = { lines: string[] } | { image: true } | { blank: true };

interface DocumentSpec {
  pages: PageSpec[];
  title?: string;
  /** Present: the file is encrypted. An empty userPassword means owner-only. */
  encryption?: { userPassword: string; ownerPassword: string };
}

function textContent(lines: string[]): Uint8Array {
  const body = lines.map((l) => `${literal(l)} Tj T*`).join("\n");
  return enc.encode(`BT\n/F1 12 Tf\n72 720 Td\n16 TL\n${body}\nET\n`);
}

function buildDocument(spec: DocumentSpec): Uint8Array<ArrayBuffer> {
  const w = new PdfWriter();
  const catalog = w.reserve();
  const pagesNode = w.reserve();
  const font = w.add({
    kind: "plain",
    body:
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding " +
      "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences " +
      "[1 /fi /fl /ff /ffi /ffl] >> >>",
  });
  // 8x8 grey gradient: enough for pdf.js to see an image and no text.
  const image = spec.pages.some((p) => "image" in p)
    ? w.add({
        kind: "stream",
        dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8",
        data: Uint8Array.from({ length: 64 }, (_, i) => (i * 4) & 255),
      })
    : undefined;

  const resources = `<< /Font << /F1 ${font} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ""} >>`;
  const kids: number[] = [];
  for (const page of spec.pages) {
    const pageNum = w.reserve();
    kids.push(pageNum);
    let contents = "";
    if ("lines" in page) {
      const stream = w.add({
        kind: "stream",
        dict: "",
        data: textContent(page.lines),
      });
      contents = ` /Contents ${stream} 0 R`;
    } else if ("image" in page) {
      const stream = w.add({
        kind: "stream",
        dict: "",
        data: enc.encode("q 400 0 0 400 100 200 cm /Im1 Do Q\n"),
      });
      contents = ` /Contents ${stream} 0 R`;
    }
    w.set(pageNum, {
      kind: "plain",
      body: `<< /Type /Page /Parent ${pagesNode} 0 R /MediaBox [0 0 612 792] /Resources ${resources}${contents} >>`,
    });
  }
  w.set(pagesNode, {
    kind: "plain",
    body: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`,
  });
  w.set(catalog, {
    kind: "plain",
    body: `<< /Type /Catalog /Pages ${pagesNode} 0 R >>`,
  });

  // Strings inside an encrypted file would have to be encrypted too, so the
  // Info dictionary (the only place we use a string) is skipped for them.
  const info =
    spec.title && !spec.encryption
      ? w.add({
          kind: "plain",
          body: `<< /Title ${literal(spec.title)} /Producer (talk-to-doc fixtures) >>`,
        })
      : undefined;

  if (!spec.encryption) return w.finish({ root: catalog, info });
  const e = standardEncryption(
    spec.encryption.userPassword,
    spec.encryption.ownerPassword,
  );
  const object = w.add({ kind: "plain", body: e.dict });
  return w.finish({
    root: catalog,
    encrypt: { object, id: FIXED_ID, streamCipher: e.streamCipher },
  });
}

/** A PDF of `n` blank pages, for the page-cap test. Not committed. */
export function buildBlankPages(n: number): Uint8Array<ArrayBuffer> {
  return buildDocument({
    pages: Array.from({ length: n }, () => ({ blank: true })),
  });
}

/** A PDF with no pages at all. */
function buildZeroPages(): Uint8Array<ArrayBuffer> {
  const w = new PdfWriter();
  const catalog = w.add({
    kind: "plain",
    body: "<< /Type /Catalog /Pages 2 0 R >>",
  });
  w.add({ kind: "plain", body: "<< /Type /Pages /Kids [] /Count 0 >>" });
  return w.finish({ root: catalog });
}

/** Header plus deterministic noise: no objects, no xref, nothing to recover. */
function buildCorrupted(): Uint8Array<ArrayBuffer> {
  let seed = 12345;
  const noise = Uint8Array.from({ length: 2048 }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed >> 16) & 255;
  });
  return Buffer.concat([enc.encode("%PDF-1.4\n"), noise]);
}

// --- Fixture content ---------------------------------------------------------

const REPORT_PAGES: string[][] = [
  [
    "Quarterly Report",
    "",
    "This report summarizes the results of the third quarter. Revenue grew",
    "by twelve percent compared with the same period last year, driven by",
    "strong demand in the northern region.",
  ],
  [
    "Operations",
    "",
    "Support tickets fell by a third after the new help centre launched.",
    "Average response time is now under two hours on weekdays.",
  ],
  [
    "Outlook",
    "",
    "We expect steady growth next quarter. The main risks are supplier",
    "delays and currency swings, both of which the team is tracking weekly.",
  ],
  [
    "Appendix",
    "",
    "Figures are unaudited. Definitions follow the glossary on page one.",
  ],
];

const FRENCH_LINES: string[] = [
  "Résumé : l’œuvre de François Mauriac, écrite à Paris.",
  "Le ﬁnancement oﬃciel a été ratiﬁé par l’équipe d’Éric.",
  "Le \uFB02euve a a\uFB04ig\u00e9 les cultivateurs du sud-ouest.",
  "Où est la bouﬃe ? “À côté du maître”, dit-elle — déjà.",
];

const HYPHEN_LINES: string[] = [
  "The informa-",
  "tion was trans-",
  "mitted over a well-known",
  "network by Jean-",
  "Pierre in 2024-",
  "05 and re-",
  "used later.",
];

const SINGLE_PAGE: string[] = [
  "A short protected document.",
  "It has one page of readable text for the extraction test.",
];

export function buildFixtures(): Map<string, Uint8Array<ArrayBuffer>> {
  return new Map<string, Uint8Array<ArrayBuffer>>([
    [
      "multi-page.pdf",
      buildDocument({
        title: "Quarterly Report 2026",
        pages: REPORT_PAGES.map((lines) => ({ lines })),
      }),
    ],
    [
      "encrypted.pdf",
      buildDocument({
        pages: [{ lines: SINGLE_PAGE }],
        encryption: { userPassword: "secret", ownerPassword: "owner" },
      }),
    ],
    [
      "owner-only.pdf",
      buildDocument({
        pages: [{ lines: SINGLE_PAGE }],
        encryption: { userPassword: "", ownerPassword: "owner" },
      }),
    ],
    ["corrupted.pdf", buildCorrupted()],
    [
      "renamed-text.pdf",
      enc.encode("This is a plain text file that was renamed to .pdf.\n"),
    ],
    ["image-only.pdf", buildDocument({ pages: [{ image: true }] })],
    [
      "partial-text.pdf",
      buildDocument({
        pages: [
          { lines: REPORT_PAGES[0] ?? [] },
          { image: true },
          { lines: REPORT_PAGES[1] ?? [] },
        ],
      }),
    ],
    ["french.pdf", buildDocument({ pages: [{ lines: FRENCH_LINES }] })],
    ["hyphenation.pdf", buildDocument({ pages: [{ lines: HYPHEN_LINES }] })],
    ["empty.pdf", buildZeroPages()],
  ]);
}

function main(): void {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "test",
    "fixtures",
    "pdf",
  );
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of buildFixtures()) {
    writeFileSync(join(dir, name), bytes);
    console.log(`${name}  ${bytes.length} bytes`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
