import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The one test that talks to the real OpenAI Realtime API (e2e/live.spec.ts,
// tag @live). It costs a few cents on gpt-realtime-2.1-mini, so it is never
// part of `pnpm test:e2e` or CI: the main config excludes @live, and this
// config is only used by `pnpm test:live`, by hand.
//
// The build here is the real thing: no mock transport. The key is read by the
// Next server itself from its own environment; this file never sees it.

const PORT = 3101;
const MODEL = process.env.REALTIME_MODEL ?? "gpt-realtime-2.1-mini";
const QUESTION = path.join(process.cwd(), "tests/fixtures/question.wav");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "live.spec.ts",
  grep: /@live/,
  // One try, never a retry: a retry would be a second paid session.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 90_000,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
    // No trace, no video: both would record the client secret in the mint
    // response. A screenshot on failure is enough to see what went wrong.
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-live",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        permissions: ["microphone"],
        launchOptions: {
          args: [
            // A fake microphone instead of the machine's, fed from a file.
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            // Loops, so the question is heard in full even though the file
            // starts playing the moment the mic opens, a little before the
            // connection to OpenAI is up. The test ends the chat as soon as
            // the first answer starts, so the repeats never get answered.
            `--use-file-for-fake-audio-capture=${QUESTION}`,
          ],
        },
      },
    },
  ],
  webServer: {
    command: `pnpm build && pnpm start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      UPLOAD_MODE: "direct",
      // The real WebRTC transport. Set on purpose: a value in .env.local must
      // not be able to turn the mock back on.
      NEXT_PUBLIC_REALTIME_TRANSPORT: "webrtc",
      REALTIME_MODEL: MODEL,
      // The chat is cut off at the server's own limit, even if the test hangs.
      MAX_SESSION_MINUTES: "2",
      SUPADATA_API_KEY: "",
    },
  },
});
