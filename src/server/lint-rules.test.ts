import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.map((m) => m.ruleId) ?? [];
}

describe("import boundaries", () => {
  it("blocks client code from importing src/server", async () => {
    const rules = await lint(
      'import { getEnv } from "@/server/env";\nexport const x = getEnv;\n',
      "src/features/ingest/x.ts",
    );
    expect(rules).toContain("no-restricted-imports");
  });

  it("blocks server code from importing features", async () => {
    const rules = await lint(
      'import { y } from "@/features/voice/y";\nexport const x = y;\n',
      "src/server/x.ts",
    );
    expect(rules).toContain("no-restricted-imports");
  });

  it("blocks process.env outside env.ts", async () => {
    const rules = await lint(
      "export const k = process.env.X;\n",
      "src/server/other.ts",
    );
    expect(rules).toContain("no-restricted-syntax");
  });
});
