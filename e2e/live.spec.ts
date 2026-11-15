import path from "node:path";
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { answers, pill } from "./support";

// @live: the only test that reaches the real OpenAI Realtime API. Run it by
// hand with `pnpm test:live` (a few cents on the mini model, twice at most).
// It is excluded from `pnpm test:e2e` and skipped in CI.
//
// Chromium plays tests/fixtures/question.wav into a fake microphone, the app
// talks to the real API, and the test asserts that an assistant transcript
// appears. It does not judge the answer, so it does not depend on what the
// question says.

const MINI = "gpt-realtime-2.1-mini";
const QUESTION = path.join(process.cwd(), "tests/fixtures/question.wav");

test.describe("@live the real Realtime API", () => {
  test.skip(!!process.env.CI, "never runs in CI: it spends real money");

  test("@live a spoken question gets an assistant transcript", async ({
    page,
  }) => {
    // The model comes from the environment (the same REALTIME_MODEL the server
    // is started with) and must be the mini one: the key has a hard $20 limit
    // shared with the review. Checked before anything is opened.
    const model = process.env.REALTIME_MODEL ?? MINI;
    expect(model, "the live test runs on gpt-realtime-2.1-mini only").toBe(
      MINI,
    );
    expect(existsSync(QUESTION), `${QUESTION} is missing`).toBe(true);

    await page.goto("/");
    // A small file through our own route: no OpenAI call until the chat starts.
    await page
      .getByLabel(/Choose a PDF/)
      .setInputFiles(
        path.join(process.cwd(), "test/fixtures/pdf/multi-page.pdf"),
      );
    await expect(
      page.getByRole("button", { name: "Start voice chat" }),
    ).toBeEnabled();

    // What the server actually minted, not just what we asked for.
    const minted = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/realtime/session") &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Start voice chat" }).click();
    const response = await minted;
    expect(response.status(), "the session mint").toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ model: MINI });

    // Either an answer or a failure card; a failure says why and stops here.
    const failure = page.getByTestId("failure-card");
    await expect(answers(page).first().or(failure)).toBeVisible({
      timeout: 60_000,
    });
    await expect(failure, "the chat failed to start").toHaveCount(0);
    await expect(answers(page).first()).toContainText(/\S/, {
      timeout: 30_000,
    });

    // Stop spending: the question loops in the fake mic, and each repeat
    // would be another turn.
    await page.getByRole("button", { name: "End", exact: true }).click();
    await page.getByRole("button", { name: "End chat" }).click();
    await expect(pill(page)).toHaveText("Ended");
  });
});
