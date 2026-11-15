/**
 * Fails when something that looks like a secret ends up in what the browser
 * can download. Run after `pnpm build`: `pnpm check:bundle`.
 *
 * Looks in the client bundle (.next/static, source maps included) and in the
 * prerendered pages and RSC payloads (.next/server/app/*.html, *.rsc, ...),
 * which are also served as-is. Server route code is not scanned: it never
 * leaves the server.
 *
 * Three kinds of finding:
 *   key-pattern  an OpenAI-style "sk-" key or a Vercel Blob token prefix
 *   env-name     the NAME of a secret variable (it should not even be mentioned)
 *   env-value    the VALUE of a secret variable that is set in this shell
 *
 * Findings never print the matched text, only the file and the kind, so a CI
 * log cannot become the leak. Node 24 runs this file directly, so keep to
 * erasable TypeScript syntax.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** Every secret variable src/server/env.ts reads. A test keeps this list in step. */
export const SECRET_ENV_NAMES: readonly string[] = [
  "OPENAI_API_KEY",
  "SUPADATA_API_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_TOKEN",
  "IP_HASH_SALT",
  "CRON_SECRET",
];

// "sk-" must start a word: "task-list" and "disk-usage" are not keys. The
// optional segment covers sk-proj-, sk-svcacct- and sk-admin-.
const KEY_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  {
    kind: "openai-key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?:[a-z]+-)?[A-Za-z0-9_-]{8,}/,
  },
  { kind: "blob-token", pattern: /vercel_blob_rw_[A-Za-z0-9]/ },
];

/**
 * Names that may appear in client JavaScript chunks, and why. The browser
 * upload client in @vercel/blob looks this variable up by name and quotes it
 * in its error messages; the browser has no value for it (only NEXT_PUBLIC_
 * variables reach it), so the name alone reveals nothing. Pages and RSC
 * payloads, where server data is serialized, get no such exception, and the
 * value check below applies to every file.
 */
const NAME_ALLOWED_IN_CHUNKS: readonly string[] = ["BLOB_READ_WRITE_TOKEN"];
// Any .js under static/: Next writes chunks to static/chunks locally, and the
// Vercel build moves them to static/immutable/chunks.
const CLIENT_CHUNK = /^static[\\/].*\.js$/;

/** Values shorter than this would match by accident (a bare "true" or "1"). */
const MIN_VALUE_LENGTH = 8;

export interface Finding {
  /** Path relative to the build directory. */
  file: string;
  kind: string;
  /** Which variable, for env-name and env-value; never the value itself. */
  name?: string;
}

export interface ScanOptions {
  /** Secret values to look for, by variable name. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Static files served as they are. Defaults to ../public next to the build. */
  publicDir?: string;
}

export function scanText(
  file: string,
  text: string,
  options: ScanOptions = {},
): Finding[] {
  const env = options.env ?? process.env;
  const findings: Finding[] = [];
  for (const { kind, pattern } of KEY_PATTERNS) {
    if (pattern.test(text)) findings.push({ file, kind });
  }
  for (const name of SECRET_ENV_NAMES) {
    const nameAllowed =
      NAME_ALLOWED_IN_CHUNKS.includes(name) && CLIENT_CHUNK.test(file);
    if (!nameAllowed && text.includes(name)) {
      findings.push({ file, kind: "env-name", name });
    }
    const value = env[name];
    if (value && value.length >= MIN_VALUE_LENGTH && text.includes(value)) {
      findings.push({ file, kind: "env-value", name });
    }
  }
  return findings;
}

// Files under .next/server/app that the browser can be sent. Everything else
// there (route.js, page.js, ...) is server code. `.body` is what a static
// route handler (an icon, the manifest) answers with.
const SERVED_FROM_SERVER_APP = /\.(?:html|rsc|meta|json|body)$/;

// public/ is served verbatim; images cannot hold a key worth a scan.
const SERVED_FROM_PUBLIC =
  /\.(?:html?|js|mjs|css|json|svg|txt|xml|webmanifest|map)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

export interface ScanResult {
  scanned: number;
  findings: Finding[];
}

/** `buildDir` is the .next directory. */
export function scanBuild(
  buildDir: string,
  options: ScanOptions = {},
): ScanResult {
  const roots: { dir: string; accept: (file: string) => boolean }[] = [
    { dir: join(buildDir, "static"), accept: () => true },
    {
      dir: join(buildDir, "server", "app"),
      accept: (file) => SERVED_FROM_SERVER_APP.test(file),
    },
    {
      dir: options.publicDir ?? join(buildDir, "..", "public"),
      accept: (file) => SERVED_FROM_PUBLIC.test(file),
    },
  ];
  let scanned = 0;
  const findings: Finding[] = [];
  for (const { dir, accept } of roots) {
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      if (!accept(file)) continue;
      scanned += 1;
      findings.push(
        ...scanText(
          // Relative to the build, so a finding in public/ reads ../public/x.
          relative(buildDir, file),
          readFileSync(file, "utf-8"),
          options,
        ),
      );
    }
  }
  return { scanned, findings };
}

function main(): number {
  const buildDir = process.argv[2] ?? ".next";
  if (!existsSync(buildDir)) {
    console.error(`No build output at ${buildDir}. Run pnpm build first.`);
    return 2;
  }
  const { scanned, findings } = scanBuild(buildDir);
  // An empty scan would pass for the wrong reason (wrong directory, new layout).
  if (scanned === 0) {
    console.error(
      `Found no client files under ${buildDir}; nothing was checked.`,
    );
    return 2;
  }
  if (findings.length > 0) {
    console.error(
      `Secret-like content in the client output (${findings.length}):`,
    );
    for (const f of findings) {
      console.error(`  ${f.kind}${f.name ? ` ${f.name}` : ""}  ${f.file}`);
    }
    return 1;
  }
  console.log(`Client bundle clean: ${scanned} files checked.`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
