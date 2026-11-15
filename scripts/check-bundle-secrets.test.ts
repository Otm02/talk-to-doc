import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_ENV_NAMES, scanBuild, scanText } from "./check-bundle-secrets";

// The scanner guards T-01. These tests prove it can fail: a check that has
// never been seen failing proves nothing.

// Assembled at run time so this file is not itself a hit for secret scanners.
const FAKE_OPENAI_KEY = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
const FAKE_VALUE = "Zq9-not-a-real-token-value";

let build: string;
beforeEach(() => {
  build = mkdtempSync(path.join(tmpdir(), "bundle-scan-"));
  mkdirSync(path.join(build, "static", "chunks"), { recursive: true });
  mkdirSync(path.join(build, "server", "app"), { recursive: true });
  writeFileSync(
    path.join(build, "static", "chunks", "app.js"),
    'const label = "task-list"; const risk = "disk-usage"; fetch("/api/health")',
  );
  writeFileSync(
    path.join(build, "server", "app", "index.html"),
    "<html><body>Talk to a document</body></html>",
  );
});
afterEach(() => rmSync(build, { recursive: true, force: true }));

// No public/ next to the temp build, so the default lookup finds nothing.
const noEnv = { env: {}, publicDir: "/nonexistent/public" };

describe("scanText", () => {
  it.each([
    ["an OpenAI project key", FAKE_OPENAI_KEY, "openai-key"],
    ["a legacy key", "sk-" + "abcdefghijklmnopqrstuvwx", "openai-key"],
    ["a short test key", "x=" + "sk-" + "test1234", "openai-key"],
    ["a Blob token", "vercel_blob_rw_" + "example", "blob-token"],
  ])("flags %s", (_name, text, kind) => {
    expect(scanText("a.js", `var k="${text}";`, noEnv)).toEqual([
      { file: "a.js", kind },
    ]);
  });

  it("does not flag words that merely contain sk-", () => {
    const text = "task-list disk-usage risk-free mask-image desk-chair";
    expect(scanText("a.js", text, noEnv)).toEqual([]);
  });

  it.each(SECRET_ENV_NAMES)("flags the name %s", (name) => {
    expect(scanText("a.js", `process.env.${name}`, noEnv)).toEqual([
      { file: "a.js", kind: "env-name", name },
    ]);
  });

  it("lets the Blob SDK's own mention of its variable name through, in client chunks only", () => {
    const text = 'throw new Error("set `BLOB_READ_WRITE_TOKEN`")';
    const chunk = path.join("static", "chunks", "sdk.js");
    expect(scanText(chunk, text, noEnv)).toEqual([]);
    // Vercel's build puts the same chunks under static/immutable/chunks.
    const onVercel = path.join(
      "static",
      "immutable",
      "chunks",
      "3tyofnure3bvb.js",
    );
    expect(scanText(onVercel, text, noEnv)).toEqual([]);
    // Not in a prerendered page, an RSC payload or a source map.
    for (const file of ["server/app/index.html", "server/app/index.rsc"]) {
      expect(scanText(file, text, noEnv)).toHaveLength(1);
    }
    expect(scanText(`${chunk}.map`, text, noEnv)).toHaveLength(1);
    // And never for any other secret.
    expect(scanText(chunk, "OPENAI_API_KEY", noEnv)).toHaveLength(1);
  });

  it("still flags the Blob token's value inside a client chunk", () => {
    const chunk = path.join("static", "chunks", "sdk.js");
    const findings = scanText(chunk, `t="${FAKE_VALUE}"`, {
      env: { BLOB_READ_WRITE_TOKEN: FAKE_VALUE },
    });
    expect(findings).toEqual([
      { file: chunk, kind: "env-value", name: "BLOB_READ_WRITE_TOKEN" },
    ]);
  });

  it("flags the value of a secret that is set, without echoing it", () => {
    const findings = scanText("a.js", `x="${FAKE_VALUE}"`, {
      env: { SUPADATA_API_KEY: FAKE_VALUE },
    });
    expect(findings).toEqual([
      { file: "a.js", kind: "env-value", name: "SUPADATA_API_KEY" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(FAKE_VALUE);
  });

  it("ignores short values that would match by accident", () => {
    expect(
      scanText("a.js", "true 1 false", {
        env: { OPENAI_API_KEY: "true", KV_REST_API_TOKEN: "1" },
      }),
    ).toEqual([]);
  });
});

describe("scanBuild", () => {
  it("passes a clean build and reports how many files it read", () => {
    expect(scanBuild(build, noEnv)).toEqual({ scanned: 2, findings: [] });
  });

  it("fails on a planted key in the client bundle", () => {
    writeFileSync(
      path.join(build, "static", "chunks", "leak.js"),
      `export const key = "${FAKE_OPENAI_KEY}";`,
    );
    const { findings } = scanBuild(build, noEnv);
    expect(findings).toEqual([
      {
        file: path.join("static", "chunks", "leak.js"),
        kind: "openai-key",
      },
    ]);
  });

  it("fails on a key hidden in a source map", () => {
    writeFileSync(
      path.join(build, "static", "chunks", "app.js.map"),
      JSON.stringify({ sourcesContent: [`const k = "${FAKE_OPENAI_KEY}"`] }),
    );
    expect(scanBuild(build, noEnv).findings).toHaveLength(1);
  });

  it("fails on a secret name in a prerendered page or RSC payload", () => {
    writeFileSync(
      path.join(build, "server", "app", "index.rsc"),
      '1:"OPENAI_API_KEY"',
    );
    const { findings } = scanBuild(build, noEnv);
    expect(findings).toEqual([
      {
        file: path.join("server", "app", "index.rsc"),
        kind: "env-name",
        name: "OPENAI_API_KEY",
      },
    ]);
  });

  it("fails on a key in a static route's .body file", () => {
    writeFileSync(
      path.join(build, "server", "app", "manifest.webmanifest.body"),
      `{"name":"${FAKE_OPENAI_KEY}"}`,
    );
    expect(scanBuild(build, noEnv).findings).toEqual([
      {
        file: path.join("server", "app", "manifest.webmanifest.body"),
        kind: "openai-key",
      },
    ]);
  });

  it("fails on a key in public/, which is served as it is", () => {
    const publicDir = path.join(build, "public");
    mkdirSync(publicDir);
    writeFileSync(path.join(publicDir, "notes.txt"), FAKE_OPENAI_KEY);
    writeFileSync(path.join(publicDir, "logo.png"), FAKE_OPENAI_KEY);
    const { findings, scanned } = scanBuild(build, { env: {}, publicDir });
    expect(scanned).toBe(3); // the two files from beforeEach and notes.txt
    expect(findings).toEqual([
      { file: path.join("public", "notes.txt"), kind: "openai-key" },
    ]);
  });

  it("looks in ../public by default, next to the build directory", () => {
    const site = mkdtempSync(path.join(tmpdir(), "bundle-site-"));
    try {
      mkdirSync(path.join(site, ".next", "static"), { recursive: true });
      mkdirSync(path.join(site, "public"));
      writeFileSync(path.join(site, ".next", "static", "a.js"), "ok");
      writeFileSync(path.join(site, "public", "b.js"), FAKE_OPENAI_KEY);
      const { findings } = scanBuild(path.join(site, ".next"), { env: {} });
      expect(findings).toHaveLength(1);
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  });

  it("does not read server code, which never reaches a browser", () => {
    writeFileSync(
      path.join(build, "server", "app", "route.js"),
      "const k = process.env.OPENAI_API_KEY;",
    );
    expect(scanBuild(build, noEnv).findings).toEqual([]);
  });
});

describe("the command", () => {
  const script = path.join(import.meta.dirname, "check-bundle-secrets.ts");
  // The shell's own secrets must not leak into what the child scans for.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SECRET_ENV_NAMES) delete env[name];
  const run = (dir: string) =>
    spawnSync(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, dir],
      { encoding: "utf-8", env },
    );

  it("exits 0 on a clean build", () => {
    const res = run(build);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("clean");
  });

  it("exits 1 on a planted key and never prints it", () => {
    writeFileSync(
      path.join(build, "static", "chunks", "leak.js"),
      `export const key = "${FAKE_OPENAI_KEY}";`,
    );
    const res = run(build);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("leak.js");
    expect(res.stderr + res.stdout).not.toContain(FAKE_OPENAI_KEY);
  });

  it("exits 2 when there is no build, instead of passing", () => {
    expect(run(path.join(build, "missing")).status).toBe(2);
  });

  it("exits 2 when the build has no client files", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "bundle-scan-empty-"));
    try {
      expect(run(empty).status).toBe(2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("the list of secret names", () => {
  it("covers every key, token and secret variable in src/server/env.ts", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../src/server/env.ts"),
      "utf-8",
    );
    const declared = [
      ...source.matchAll(
        /^ {2}([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_SALT)):/gm,
      ),
    ].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...SECRET_ENV_NAMES].sort()).toEqual([...declared].sort());
  });
});
