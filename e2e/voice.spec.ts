import { expect, test, type Page } from "@playwright/test";

// The conversation screen on the mock transport: no OpenAI, no network. The
// build sets NEXT_PUBLIC_REALTIME_TRANSPORT=mock and the URL picks a script.
// getUserMedia is stubbed so Chromium and WebKit both run it.

type MicMode = "ok" | "denied";
type MicWindow = Window & { __mic?: MicMode; __micCalls?: number };

/**
 * getUserMedia and the Permissions API, both answering from `window.__mic`, so
 * a test can deny the mic at the start and allow it later (setMic).
 */
async function stubMic(page: Page, mode: MicMode) {
  await page.addInitScript((m) => {
    const w = window as MicWindow;
    w.__mic = m;
    w.__micCalls = 0;
    if (typeof MediaDevices === "undefined") return;
    // On the prototype, not on navigator.mediaDevices: WebKit can drop a
    // property set on that object between two calls, and the real
    // getUserMedia (which refuses under automation) would answer the second.
    MediaDevices.prototype.getUserMedia = async () => {
      w.__micCalls = (w.__micCalls ?? 0) + 1;
      if (w.__mic === "denied") throw new DOMException("no", "NotAllowedError");
      const ctx = new AudioContext();
      return ctx.createMediaStreamDestination().stream;
    };
    const query = async () =>
      ({
        state: w.__mic === "denied" ? "denied" : "granted",
      }) as PermissionStatus;
    // An own property on navigator: assigning to permissions.query is ignored
    // by WebKit, which would then answer "denied" for real.
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query },
    });
  }, mode);
}

const setMic = (page: Page, mode: MicMode) =>
  page.evaluate((m) => void ((window as MicWindow).__mic = m), mode);
const micCalls = (page: Page) =>
  page.evaluate(() => (window as MicWindow).__micCalls ?? 0);

/** Every request to our API or to OpenAI from now on. The mock needs none. */
function watchApi(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/|openai\.com/.test(r.url())) seen.push(r.url());
  });
  return seen;
}

// Every test needs a ready document. The real ingest route is rate limited per
// IP and covered by ingest-pdf.spec.ts, so these tests answer it themselves.
async function stubIngest(page: Page) {
  const lines = [
    {
      documentId: "e2e-doc",
      title: "Annual report",
      sourceType: "pdf",
      pages: 4,
    },
    { page: 1, text: "Annual report. Contents and a letter from the chair." },
    {
      page: 2,
      text: "Revenue grew twelve percent last year. Margins were forty percent.",
    },
    { page: 3, text: "Outlook: growth is expected to continue next year." },
    { page: 4, text: "Outlook, continued: risks and assumptions." },
    { done: true, stats: { pages: 4, words: 34, tokens: 44 }, coverage: 1 },
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
  await expect(
    page.getByRole("button", { name: "Start voice chat" }),
  ).toBeEnabled();
}
const pill = (page: Page) => page.getByTestId("status-pill");
const answers = (page: Page) => page.getByTestId("item-assistant");
const users = (page: Page) => page.getByTestId("item-user");

test.describe("conversation screen on the mock transport", () => {
  test("a full voice turn", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();

    await expect(pill(page)).toHaveText(/Listening|You're speaking/, {
      timeout: 10_000,
    });
    await expect(users(page).first()).toContainText("What was revenue?", {
      timeout: 10_000,
    });
    await expect(answers(page).first()).toBeVisible({ timeout: 10_000 });
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("session-timer")).toBeVisible();
    await expect(page.getByTestId("transcript")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  test("barge-in keeps the cut-off answer and marks it", async ({ page }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=barge-in");
    await page.getByRole("button", { name: "Start voice chat" }).click();

    await expect(answers(page).first()).toHaveAttribute(
      "data-status",
      "interrupted",
      {
        timeout: 15_000,
      },
    );
    await expect(page.getByTestId("interrupted-marker")).toBeVisible();
    await expect(answers(page).nth(1)).toContainText(
      "Margins were forty percent.",
      {
        timeout: 15_000,
      },
    );
  });

  test("a denied mic lands in text mode with a banner and a way back", async ({
    page,
  }) => {
    await stubMic(page, "denied");
    await openDoc(page, "mockRealtime=text-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();

    const banner = page.getByTestId("mic-banner");
    await expect(banner).toContainText(
      "Microphone unavailable, you're in text mode",
      {
        timeout: 10_000,
      },
    );
    await expect(
      page.getByRole("button", { name: "Try microphone again" }),
    ).toBeVisible();
    // A text chat is not "Listening": there is no mic.
    await expect(pill(page)).toHaveText("Ready");

    const composer = page.getByTestId("composer");
    await composer.fill("What is this about?");
    await composer.press("Enter");
    await expect(users(page).first()).toContainText("What is this about?");
    await expect(answers(page).first()).toBeVisible({ timeout: 10_000 });
  });

  test("retrying a mic that is still blocked: no request, button stays, coach opens", async ({
    page,
  }) => {
    await stubMic(page, "denied");
    await openDoc(page, "mockRealtime=text-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    const retry = page.getByRole("button", { name: "Try microphone again" });
    await expect(retry).toBeEnabled({ timeout: 10_000 });
    const callsBefore = await micCalls(page);
    const api = watchApi(page);

    for (let i = 0; i < 4; i += 1) {
      await retry.click();
      await page.waitForTimeout(1100); // past the debounce
    }

    // The Permissions API said "denied", so getUserMedia was not even called,
    // and nothing went to our API or to OpenAI.
    expect(await micCalls(page)).toBe(callsBefore);
    expect(api).toEqual([]);
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    const coach = page.getByTestId("mic-coach");
    await expect(coach).toContainText("Open Permissions.");
    await expect(coach).toContainText("Set Microphone to Allow.");
    await expect(coach).toContainText(
      "Come back and tap 'Try microphone again'",
    );
    // The chat is still up: typing works exactly as before.
    await expect(pill(page)).toHaveText("Ready");
    await expect(page.getByTestId("failure-card")).toHaveCount(0);
    await page.getByTestId("composer").fill("Still there?");
    await page.getByTestId("composer").press("Enter");
    await expect(answers(page).first()).toBeVisible({ timeout: 10_000 });
  });

  test("retrying once the mic is allowed upgrades the same chat to voice", async ({
    page,
  }) => {
    await stubMic(page, "denied");
    await openDoc(page, "mockRealtime=text-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(page.getByTestId("mic-banner")).toBeVisible({
      timeout: 10_000,
    });
    const composer = page.getByTestId("composer");
    await composer.fill("What is this about?");
    await composer.press("Enter");
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 10_000,
    });
    const api = watchApi(page);

    await setMic(page, "ok");
    await page.getByRole("button", { name: "Try microphone again" }).click();

    await expect(pill(page)).toHaveText("Listening", { timeout: 10_000 });
    await expect(page.getByTestId("mic-banner")).toHaveCount(0);
    await expect(page.getByTestId("orb")).toBeVisible();
    await expect(page.getByRole("button", { name: "Mute" })).toBeEnabled();
    // Same chat: what was said before the upgrade is still on screen, and the
    // upgrade itself needed no request.
    await expect(users(page).first()).toContainText("What is this about?");
    await expect(answers(page)).toHaveCount(1);
    expect(api).toEqual([]);
  });

  test("if the track cannot be swapped in, one reconnect ends in a voice chat", async ({
    page,
  }) => {
    await stubMic(page, "denied");
    await openDoc(page, "mockRealtime=text-turn&mockMicUpgrade=fail");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(page.getByTestId("mic-banner")).toBeVisible({
      timeout: 10_000,
    });
    const callsBefore = await micCalls(page);

    await setMic(page, "ok");
    await page.getByRole("button", { name: "Try microphone again" }).click();

    await expect(pill(page)).toHaveText("Listening", { timeout: 10_000 });
    await expect(page.getByTestId("mic-banner")).toHaveCount(0);
    // One getUserMedia for the retry; the reconnect reused that stream.
    expect(await micCalls(page)).toBe(callsBefore + 1);
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
    await expect(pill(page)).toHaveText(
      /Listening|You're speaking|Speaking|Thinking/,
      {
        timeout: 10_000,
      },
    );

    await page.getByRole("button", { name: "Mute" }).click();
    await expect(pill(page)).toHaveText("Muted");
    await page.getByRole("button", { name: "Unmute" }).click();
    await expect(pill(page)).not.toHaveText("Muted");
  });

  test("the keyboard button opens the composer and the compact layout", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(pill(page)).toHaveText(
      /Listening|You're speaking|Speaking|Thinking/,
      {
        timeout: 10_000,
      },
    );
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await expect(page.getByTestId("orb")).toBeVisible();

    await page.getByRole("button", { name: "Keyboard" }).click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("conversation")).toHaveAttribute(
      "data-layout",
      "compact",
    );
    // The orb folds into a dot in the pill; the bar folds into the composer row.
    await expect(page.getByTestId("orb")).toHaveCount(0);
    await expect(pill(page).getByTestId("level-dot")).toBeVisible();
    await expect(page.getByRole("toolbar")).toHaveCount(0);
    const row = page.getByTestId("composer-row");
    await expect(row.getByRole("button", { name: "Mute" })).toBeVisible();
    await expect(
      row.getByRole("button", { name: /Send|Stop answer/ }),
    ).toBeVisible();
    await expect(
      row.getByRole("button", { name: "End", exact: true }),
    ).toBeVisible();

    // And back, from the overflow menu.
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Hide keyboard" }).click();
    await expect(page.getByTestId("orb")).toBeVisible();
    await expect(page.getByTestId("conversation")).toHaveAttribute(
      "data-layout",
      "full",
    );
  });

  test("with the composer open at 390x420, the transcript gets at least 70% of the visible height", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Keyboard" }).click();
    await expect(page.getByTestId("composer")).toBeFocused();

    // What is left of a 390x844 phone once the soft keyboard is up.
    await page.setViewportSize({ width: 390, height: 420 });
    await expect
      .poll(() =>
        page.evaluate(
          () => window.visualViewport?.height ?? window.innerHeight,
        ),
      )
      .toBe(420);

    const sizes = async () =>
      page.evaluate(() => {
        const box = (id: string) =>
          document
            .querySelector(`[data-testid="${id}"]`)
            ?.getBoundingClientRect();
        const screen = box("conversation");
        const transcript = box("transcript-region");
        const row = box("composer-row");
        return {
          visible: window.visualViewport?.height ?? window.innerHeight,
          screenTop: screen?.top ?? -1,
          screenBottom: screen?.bottom ?? -1,
          transcript: transcript?.height ?? 0,
          rowBottom: row?.bottom ?? -1,
        };
      });
    await expect.poll(async () => (await sizes()).screenBottom).toBe(420);
    const s = await sizes();
    expect(s.transcript / s.visible).toBeGreaterThanOrEqual(0.7);
    // The screen is exactly the visible area, with the composer on its bottom edge.
    expect(s.screenTop).toBe(0);
    expect(s.rowBottom).toBeLessThanOrEqual(420);
    expect(s.rowBottom).toBeGreaterThan(410);
    // Everything that matters is still there and reachable.
    await expect(
      page
        .getByTestId("conversation")
        .getByRole("heading", { name: "Annual report" }),
    ).toBeVisible();
    await expect(pill(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
    await expect(answers(page).first()).toBeInViewport();
  });

  test("End asks first, then ends the chat and keeps the transcript", async ({
    page,
  }) => {
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
    await expect(
      page.getByRole("button", { name: "Start voice chat" }),
    ).toBeVisible();
  });

  test("the chat ends at its time limit with the right copy", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn&mockCap=3");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(pill(page)).toHaveText("Ended", { timeout: 15_000 });
    await expect(page.getByTestId("ended-panel")).toContainText("limit");
  });

  test("a per-IP 429 is a Cooldown that counts down and then lets you retry", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await openDoc(
      page,
      "mockRealtime=normal-turn&mockMintError=rate_limited&mockRetryAfter=8",
    );
    await page.getByRole("button", { name: "Start voice chat" }).click();

    const card = page.getByTestId("failure-card");
    await expect(card).toContainText("Too many tries.", { timeout: 10_000 });
    await expect(pill(page)).toHaveText("Cooldown");
    const retry = page.getByTestId("retry-button");
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveText(/^Try again in [5-8]s$/);
    // Said once for screen readers at the start, in words, not on every tick.
    await expect(card.getByRole("alert")).toContainText(
      "You can try again in 8 seconds.",
    );
    // It ticks: a lower number shows up without anything being tapped.
    await expect(retry).toHaveText(/^Try again in [1-4]s$/, { timeout: 8000 });
    await expect(retry).toBeDisabled();

    await expect(retry).toBeEnabled({ timeout: 8000 });
    await expect(retry).toHaveText("Try again");
    await expect(page.getByTestId("retry-wait-end")).toHaveText(
      "You can try again now.",
    );

    // Retrying is refused again (the mock always refuses): a fresh countdown.
    await retry.click();
    await expect(page.getByTestId("retry-button")).toBeDisabled({
      timeout: 10_000,
    });
    await expect(pill(page)).toHaveText("Cooldown");
  });

  for (const [code, copy, label] of [
    ["voice_disabled", "Voice is paused right now", "Unavailable"],
    [
      "daily_limit",
      "voice sessions for today are used up",
      "Daily limit reached",
    ],
    ["budget_exhausted", "API budget is used up", "Unavailable"],
  ] as const) {
    test(`budget error ${code}: copy shown, text usable, no automatic retry`, async ({
      page,
    }) => {
      await stubMic(page, "ok");
      await openDoc(
        page,
        `mockRealtime=normal-turn&mockMintError=${code}&mockRetryAfter=45`,
      );
      await page.getByRole("button", { name: "Start voice chat" }).click();

      const card = page.getByTestId("failure-card");
      await expect(card).toContainText(copy, { timeout: 10_000 });
      await expect(card).toHaveAttribute("data-code", code);
      // A server that answered "no" is not offline.
      await expect(pill(page)).toHaveText(label);
      await expect(page.getByTestId("retry-button")).toHaveText(
        /^Try again in 4\ds$/,
      );

      // The extracted text stays one tap away.
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("button", { name: "Show full text" }).click();
      await expect(
        page.getByRole("dialog").getByText("Page 1", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close full text" }).click();

      // Nothing retries on its own.
      await page.waitForTimeout(1500);
      await expect(page.getByTestId("failure-card")).toHaveCount(1);
      await expect(pill(page)).toHaveText(label);
    });
  }

  test("page references become chips that open the full text at that page", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=grounding");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });

    const chips = answers(page).first().getByTestId("ref-chip");
    // "Page 40" is past the end of this 4-page document: it stays plain text.
    await expect(chips).toHaveText(["page 2", "pages 3 to 4"]);
    await expect(answers(page).first()).toContainText(
      "Page 40 is not in this report.",
    );

    await chips.nth(1).click();
    const sheet = page.getByRole("dialog", { name: "Full text" });
    const page3 = sheet.getByRole("region", { name: "Page 3" });
    await expect(page3).toBeInViewport();
    await expect(page3).toHaveAttribute("data-highlight", "true");
    // Brief: the mark goes away on its own.
    await expect(page3).not.toHaveAttribute("data-highlight", "true", {
      timeout: 4000,
    });
    await page.getByRole("button", { name: "Close full text" }).click();

    await chips.first().click();
    await expect(sheet.getByRole("region", { name: "Page 2" })).toHaveAttribute(
      "data-highlight",
      "true",
    );
  });

  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("a chip marks the page with a still outline, not a fading wash", async ({
      page,
    }) => {
      await stubMic(page, "ok");
      await openDoc(page, "mockRealtime=grounding");
      await page.getByRole("button", { name: "Start voice chat" }).click();
      await expect(answers(page).first()).toHaveAttribute(
        "data-status",
        "done",
        { timeout: 20_000 },
      );
      await answers(page).first().getByTestId("ref-chip").first().click();
      const mark = page
        .getByRole("dialog", { name: "Full text" })
        .getByRole("region", { name: "Page 2" });
      await expect(mark).toHaveAttribute("data-highlight", "true");
      const style = await mark.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          animationName: cs.animationName,
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
        };
      });
      expect(style.animationName).toBe("none");
      expect(style.outlineStyle).toBe("solid");
      expect(style.outlineWidth).toBe("2px");
    });

    test("the level dot has no motion hook to move", async ({ page }) => {
      await stubMic(page, "ok");
      await openDoc(page, "mockRealtime=normal-turn");
      await page.getByRole("button", { name: "Start voice chat" }).click();
      await expect(answers(page).first()).toHaveAttribute(
        "data-status",
        "done",
        { timeout: 15_000 },
      );
      await page.getByRole("button", { name: "Keyboard" }).click();
      const dot = page.getByTestId("level-dot");
      await expect(dot).toBeVisible();
      // The assistant spoke, yet the dot never left rest.
      await expect(dot).toHaveCSS("--level", "0");
    });
  });

  test("the transcript downloads as Markdown, from the menu and after the chat", async ({
    page,
  }) => {
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "More" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download transcript" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^annual-report-\d{4}-\d{2}-\d{2}\.md$/,
    );
    const stream = await download.createReadStream();
    let text = "";
    for await (const chunk of stream) text += String(chunk);
    expect(text).toContain("# Annual report\n");
    expect(text).toContain("- Source: sample.pdf\n");
    expect(text).toMatch(/- Date: \d{4}-\d{2}-\d{2}\n/);
    expect(text).toContain("- Model: gpt-realtime-2.1-mini\n");
    expect(text).toContain("**You:** What was revenue?\n");
    expect(text).toContain(
      "**Assistant:** Revenue grew twelve percent last year.\n",
    );
    await expect(
      page.getByRole("button", { name: "Saved as Markdown" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close menu" }).click();

    // The same two actions are on the ended screen.
    await page.getByRole("button", { name: "End", exact: true }).click();
    await page.getByRole("button", { name: "End chat" }).click();
    const panel = page.getByTestId("ended-panel");
    await expect(panel.getByRole("button", { name: "Copy" })).toBeEnabled();
    const [again] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(again.suggestedFilename()).toBe(download.suggestedFilename());
  });

  test("Copy puts the transcript on the clipboard", async ({
    page,
    context,
    browserName,
  }) => {
    // Only Chromium lets a test grant and read the clipboard.
    test.skip(
      browserName !== "chromium",
      "clipboard permissions are Chromium-only",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await stubMic(page, "ok");
    await openDoc(page, "mockRealtime=normal-turn");
    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(answers(page).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("button", { name: "Copy transcript" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain("**You:** What was revenue?");
    expect(text).toContain(
      "**Assistant:** Revenue grew twelve percent last year.",
    );
  });

  test("a budget error that arrives mid-chat is shown too", async ({
    page,
  }) => {
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
