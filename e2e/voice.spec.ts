import { expect, test, type Page } from "@playwright/test";

// The conversation screen on the mock transport: no OpenAI, no network. The
// build sets NEXT_PUBLIC_REALTIME_TRANSPORT=mock and the URL picks a script.
// getUserMedia is stubbed so Chromium and WebKit both run it.

async function stubMic(page: Page, mode: "ok" | "denied") {
  await page.addInitScript((m) => {
    const md = navigator.mediaDevices;
    if (!md) return;
    md.getUserMedia = async () => {
      if (m === "denied") throw new DOMException("no", "NotAllowedError");
      const ctx = new AudioContext();
      return ctx.createMediaStreamDestination().stream;
    };
  }, mode);
}

// Every test needs a ready document. The real ingest route is rate limited per
// IP and covered by ingest-pdf.spec.ts, so these tests answer it themselves.
async function stubIngest(page: Page) {
  const lines = [
    { documentId: "e2e-doc", title: "Annual report", sourceType: "pdf", pages: 1 },
    { page: 1, text: "Revenue grew twelve percent last year. Margins were forty percent." },
    { done: true, stats: { pages: 1, words: 10, tokens: 14 }, coverage: 1 },
  ];
  await page.route("**/api/ingest/pdf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    }),
  );
}

/** Open the sample document, then tap a start button. */
async function openDoc(page: Page, query: string) {
  await stubIngest(page);
  await page.goto(`/?${query}`);
  await page.getByRole("button", { name: "Sample PDF" }).click();
  await expect(page.getByRole("button", { name: "Start voice chat" })).toBeEnabled();
}
const pill = (page: Page) => page.getByTestId("status-pill");
const answers = (page: Page) => page.getByTestId("item-assistant");
const users = (page: Page) => page.getByTestId("item-user");

test.describe("conversation screen on the mock transport", () => {
  test("a full voice turn", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();

    await expect(pill(page)).toHaveText(/Listening|You're speaking/, { timeout: 10_000 });
    await expect(users(page).first()).toContainText("What was revenue?", { timeout: 10_000 });
    await expect(answers(page).first()).toBeVisible({ timeout: 10_000 });
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("session-timer")).toBeVisible();
    await expect(page.getByTestId("transcript")).toHaveAttribute("aria-live", "polite");
  });

  test("barge-in keeps the cut-off answer and marks it", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=barge-in");
    await page.getByRole("button", { name: "Start voice chat" }).click();

    await expect(answers(page).first()).toHaveAttribute("data-status", "interrupted", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("interrupted-marker")).toBeVisible();
    await expect(answers(page).nth(1)).toContainText("Margins were forty percent.", {
      timeout: 15_000,
    });
  });

  test("a denied mic lands in text mode with a banner and a way back", async ({ page }) => {
    await stubMic(page, "denied");
    await openDoc(page, "mockRealtime=text-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();

    const banner = page.getByTestId("mic-banner");
    await expect(banner).toContainText("Microphone unavailable, you're in text mode", {
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: "Try microphone again" })).toBeVisible();

    const composer = page.getByTestId("composer");
    await composer.fill("What is this about?");
    await composer.press("Enter");
    await expect(users(page).first()).toContainText("What is this about?");
    await expect(answers(page).first()).toBeVisible({ timeout: 10_000 });

  });

  test("Type instead starts in text mode with no banner", async ({ page }) => {
    await openDoc(page, "mockRealtime=text-turn");
    await page.getByRole("button", { name: "Type instead" }).click();
    await expect(page.getByTestId("composer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("mic-banner")).toHaveCount(0);
  });

  test("mute shows in the status pill and can be undone", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn&mockWordMs=2000");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(pill(page)).toHaveText(/Listening|You're speaking|Speaking|Thinking/, {
      timeout: 10_000,
    });

    await page.getByRole("button", { name: "Mute" }).click();
    await expect(pill(page)).toHaveText("Muted");
    await page.getByRole("button", { name: "Unmute" }).click();
    await expect(pill(page)).not.toHaveText("Muted");
  });

  test("the keyboard button opens the composer in voice mode", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(pill(page)).toHaveText(/Listening|You're speaking|Speaking|Thinking/, {
      timeout: 10_000,
    });
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await page.getByRole("button", { name: "Keyboard" }).click();
    await expect(page.getByTestId("composer")).toBeVisible();
  });

  test("End asks first, then ends the chat and keeps the transcript", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(users(page).first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "End", exact: true }).click();
    await page.getByRole("button", { name: "Keep talking" }).click();
    await expect(pill(page)).not.toHaveText("Ended");

    await page.getByRole("button", { name: "End", exact: true }).click();
    await page.getByRole("button", { name: "End chat" }).click();
    await expect(pill(page)).toHaveText("Ended");
    await expect(users(page).first()).toBeVisible();

    await page.getByRole("button", { name: "Back to document" }).click();
    await expect(page.getByRole("button", { name: "Start voice chat" })).toBeVisible();
  });

  test("the chat ends at its time limit with the right copy", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn&mockCap=3");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(pill(page)).toHaveText("Ended", { timeout: 15_000 });
    await expect(page.getByTestId("ended-panel")).toContainText("limit");
  });

  for (const [code, copy] of [
    ["voice_disabled", "Voice is paused right now"],
    ["daily_limit", "voice sessions for today are used up"],
    ["budget_exhausted", "API budget is used up"],
  ] as const) {
    test(`budget error ${code}: copy shown, text usable, no automatic retry`, async ({
      page,
    }) => {
      await stubMic(page, "ok");
      await openDoc(page, `mockRealtime=normal-turn&mockMintError=${code}&mockRetryAfter=45`);
      await page.getByRole("button", { name: "Start voice chat" }).click();

      const card = page.getByTestId("failure-card");
      await expect(card).toContainText(copy, { timeout: 10_000 });
      await expect(card).toHaveAttribute("data-code", code);
      await expect(pill(page)).toHaveText("Offline");
      await expect(card).toContainText("try again in 45 seconds");

      // The extracted text stays one tap away.
      await page.getByRole("button", { name: "Text", exact: true }).click();
      await expect(page.getByRole("dialog").getByText("Page 1", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Close full text" }).click();

      // Nothing retries on its own.
      await page.waitForTimeout(1500);
      await expect(page.getByTestId("failure-card")).toHaveCount(1);
      await expect(pill(page)).toHaveText("Offline");
    });
  }

  test("a budget error that arrives mid-chat is shown too", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=budget");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(page.getByTestId("failure-card")).toHaveAttribute(
      "data-code",
      "budget_exhausted",
      { timeout: 10_000 },
    );
  });
});
