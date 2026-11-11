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
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
