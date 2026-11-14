import { expect, test, type Page } from "@playwright/test";

// Drives the realtime engine through the mock transport: no OpenAI, no
// network. The build sets NEXT_PUBLIC_REALTIME_TRANSPORT=mock, and the URL
// picks a scripted scenario. getUserMedia is stubbed so both Chromium and
// WebKit can run it.

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

const users = (page: Page) => page.getByTestId("item-user");
const answers = (page: Page) => page.getByTestId("item-assistant");

test.describe("dev voice harness on the mock transport", () => {
  test("barge-in: the cut-off answer is kept and marked, and the follow-up is answered", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await page.goto("/dev/voice?mockRealtime=barge-in");
    await page.getByTestId("start-voice").click();
    await expect(page.getByTestId("status")).toHaveText("connected");

    await expect(answers(page).first()).toHaveAttribute(
      "data-status",
      "interrupted",
      { timeout: 15_000 },
    );
    await expect(answers(page).first()).toContainText(
      "The report covers revenue, margins and (interrupted)",
    );
    await expect(answers(page).nth(1)).toContainText(
      "Margins were forty percent.",
      { timeout: 15_000 },
    );
    await expect(answers(page).nth(1)).toHaveAttribute("data-status", "done");

    // Conversation order, whatever order things arrived in.
    await expect(
      page.getByTestId("transcript").getByRole("listitem"),
    ).toHaveText([
      /You\s*Summarise this report\./,
      /Assistant\s*The report covers revenue, margins and\s*\(interrupted\)/,
      /You\s*Just the margins\./,
      /Assistant\s*Margins were forty percent\./,
    ]);
    await expect(page.getByTestId("activity")).toHaveText("Listening", {
      timeout: 5000,
    });
    await page.screenshot({ path: "test-results/dev-voice-barge-in.png" });
  });

  test("shows a transcribing placeholder, then the words, when transcription is late", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await page.goto("/dev/voice?mockRealtime=late-transcription");
    await page.getByTestId("start-voice").click();
    await expect(users(page).first()).toContainText("transcribing…", {
      timeout: 10_000,
    });
    await expect(answers(page).first()).toBeVisible({ timeout: 10_000 });
    // The user's words appear above the reply that started first.
    await expect(users(page).first()).toContainText("What was revenue?", {
      timeout: 10_000,
    });
    await expect(
      page.getByTestId("transcript").getByRole("listitem").first(),
    ).toContainText("You");
  });

  test("marks a question it could not transcribe", async ({ page }) => {
    await stubMic(page, "ok");
    await page.goto("/dev/voice?mockRealtime=failed-transcription");
    await page.getByTestId("start-voice").click();
    await expect(users(page).first()).toContainText("couldn't transcribe", {
      timeout: 10_000,
    });
    await expect(answers(page).first()).toContainText(
      "Revenue grew twelve percent last year.",
      { timeout: 10_000 },
    );
  });

  test("text turn: the bubble shows at once, then the streamed reply", async ({
    page,
  }) => {
    await page.goto("/dev/voice?mockRealtime=text-turn&debug=1");
    await page.getByTestId("start-text").click();
    await expect(page.getByTestId("status")).toHaveText("connected");

    await page.getByTestId("composer").fill("What was revenue?");
    await page.getByTestId("send").click();
    await expect(users(page).first()).toContainText("What was revenue?");
    await expect(answers(page).first()).toContainText(
      "Revenue grew twelve percent last year.",
      { timeout: 10_000 },
    );
    await expect(users(page).first()).toHaveAttribute("data-status", "done");
    await expect(answers(page).first()).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("activity")).toHaveText("Listening");

    // The dev-only cost overlay priced the response.
    await expect(page.getByTestId("cost-total")).not.toHaveText("$0.0000");
    await expect(page.getByTestId("cost-total")).toHaveText(/^\$0\.\d+$/);
  });

  test("stop answer ends a streaming reply early and marks it interrupted", async ({
    page,
  }) => {
    // 400 ms per word: slow enough to stop it mid-sentence.
    await page.goto("/dev/voice?mockRealtime=text-turn&mockWordMs=400");
    await page.getByTestId("start-text").click();
    await expect(page.getByTestId("status")).toHaveText("connected");
    await page.getByTestId("composer").fill("Go on");
    await page.getByTestId("send").click();
    await expect(answers(page).first()).toContainText("Revenue");
    await expect(page.getByTestId("stop")).toBeEnabled();
    await page.getByTestId("stop").click();
    await expect(answers(page).first()).toHaveAttribute(
      "data-status",
      "interrupted",
    );
    // Only the words so far are kept: the rest of the sentence never arrives.
    await expect(answers(page).first()).not.toContainText("last year");
    await expect(answers(page).first()).toContainText("(interrupted)");
    await page.waitForTimeout(1500);
    await expect(answers(page).first()).not.toContainText("last year");
    await expect(page.getByTestId("activity")).toHaveText("Listening");
  });

  test("a denied mic falls back to text mode with the right words", async ({
    page,
  }) => {
    await stubMic(page, "denied");
    await page.goto("/dev/voice?mockRealtime=text-turn");
    await page.getByTestId("start-voice").click();
    await expect(page.getByTestId("status")).toHaveText("connected");
    await expect(page.getByTestId("mic-issue")).toContainText(
      "Microphone access is off.",
    );
    await expect(page.getByTestId("mute")).toBeDisabled();
    await page.getByTestId("composer").fill("Hello");
    await page.getByTestId("send").click();
    await expect(answers(page).first()).toBeVisible({ timeout: 10_000 });
  });

  test("a recoverable error shows a notice and the chat keeps going", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await page.goto("/dev/voice?mockRealtime=error");
    await page.getByTestId("start-voice").click();
    await expect(page.getByTestId("notice")).toContainText("invalid_value", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("status")).toHaveText("connected");
    await expect(answers(page).first()).toContainText("Revenue grew", {
      timeout: 10_000,
    });
  });

  test("unknown and malformed events are counted and harmless", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await page.goto("/dev/voice?mockRealtime=unknown-event");
    await page.getByTestId("start-voice").click();
    await expect(page.getByTestId("diagnostics")).toContainText(
      "unknown events 1 · malformed 2",
      { timeout: 10_000 },
    );
    await expect(answers(page).first()).toContainText("Revenue grew", {
      timeout: 10_000,
    });
  });

  test("a billing error ends the chat with the budget copy", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await page.goto("/dev/voice?mockRealtime=budget");
    await page.getByTestId("start-voice").click();
    await expect(page.getByTestId("status")).toHaveText(
      "failed (budget_exhausted)",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("message")).toHaveText(
      "The demo's API budget is used up; the extracted text still works.",
    );
    await expect(page.getByTestId("start-voice")).toBeEnabled();
  });

  test("End stops the chat and keeps the transcript; Start again works", async ({
    page,
  }) => {
    await page.goto("/dev/voice?mockRealtime=text-turn");
    await page.getByTestId("start-text").click();
    await expect(page.getByTestId("status")).toHaveText("connected");
    await page.getByTestId("composer").fill("Hi");
    await page.getByTestId("send").click();
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 10_000,
    });
    await page.getByTestId("end").click();
    await expect(page.getByTestId("status")).toHaveText("ended (user)");
    await expect(users(page)).toHaveCount(1);
    await page.getByTestId("start-text").click();
    await expect(page.getByTestId("status")).toHaveText("connected");
    await expect(users(page)).toHaveCount(0);
  });

  test("the chat cap ends the chat with the max-duration copy", async ({
    page,
  }) => {
    await page.goto("/dev/voice?mockRealtime=text-turn&mockCap=3");
    await page.getByTestId("start-text").click();
    await expect(page.getByTestId("status")).toHaveText(
      "ended (max_duration)",
      {
        timeout: 10_000,
      },
    );
    await expect(page.getByTestId("message")).toContainText("-minute limit");
  });

  test("fits a phone screen with no sideways scroll, and taps are 44px", async ({
    page,
  }) => {
    await page.goto("/dev/voice?mockRealtime=text-turn&debug=1");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    for (const id of [
      "start-voice",
      "start-text",
      "end",
      "mute",
      "stop",
      "send",
    ]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(44);
    }
  });
});
