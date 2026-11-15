import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@test": path.resolve(import.meta.dirname, "test"),
      // The real package throws outside the Next server bundle.
      "server-only": path.resolve(
        import.meta.dirname,
        "test/server-only-stub.ts",
      ),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The realtime engine carries the review's "start, interrupt, follow
      // up" test, so it is held to a bar; the rest is not gated.
      include: ["src/features/voice/realtime/**"],
      exclude: ["**/*.test.{ts,tsx}"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
});
