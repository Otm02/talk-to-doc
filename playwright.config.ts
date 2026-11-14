import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const viewport = { width: 390, height: 844 };

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport } },
    // WebKit with a phone viewport; devices["iPhone 14"] is 390x664 so override.
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport } },
  ],
  webServer: {
    command: `pnpm build && pnpm start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      UPLOAD_MODE: "direct",
      NEXT_PUBLIC_REALTIME_TRANSPORT: "mock",
      // Keep e2e hermetic: never inherit real keys or a hosted state backend.
      OPENAI_API_KEY: "",
      // The YouTube route must never reach a real provider from e2e.
      SUPADATA_API_KEY: "",
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      KV_REST_API_URL: "",
      KV_REST_API_TOKEN: "",
    },
  },
});
