import { expect, test, type Page, type Route } from "@playwright/test";

// Poor-network behavior, end to end, with no OpenAI and no real network
// trouble. Voice: the mock transport drops, fails and recovers on a script
// (?mockNet=...), and the mint goes through the real client to a route that
// counts every request. HTTP: routes abort, cut and delay the real calls.
//
// Chrome DevTools throttling shapes HTTP only, never WebRTC media, so the
// WebRTC side is covered here by the mock and by hand (docs/ARCHITECTURE.md).

type MicWindow = Window & {
  __micCalls?: number;
  __streams?: MediaStream[];
};

/** getUploadMode answers "direct" locally, so file uploads go to the route. */
async function stubMic(page: Page) {
  await page.addInitScript(() => {
    const w = window as MicWindow;
    w.__micCalls = 0;
    w.__streams = [];
    if (typeof MediaDevices === "undefined") return;
    MediaDevices.prototype.getUserMedia = async () => {
      w.__micCalls = (w.__micCalls ?? 0) + 1;
      const stream = new AudioContext().createMediaStreamDestination().stream;
      w.__streams?.push(stream);
      return stream;
    };
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "granted" }) as PermissionStatus },
    });
  });
}

const SESSION = {
  clientSecret: "mock-secret",
  expiresAt: 0,
  model: "gpt-realtime-2.1-mini",
  maxSessionSeconds: 300,
};

const pdfLines = [
  {
    documentId: "e2e-doc",
    title: "Annual report",
    sourceType: "pdf",
    pages: 2,
  },
  { page: 1, text: "Annual report. A letter from the chair." },
  { page: 2, text: "Revenue grew twelve percent last year." },
  { done: true, stats: { pages: 2, words: 14, tokens: 20 }, coverage: 1 },
];
const nd = (lines: unknown[]) =>
  lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** The sample PDF's ingest answers from here; counts how often it is asked. */
async function stubPdfIngest(page: Page) {
  const hits = { n: 0 };
  await page.route("**/api/ingest/pdf", (route) => {
    hits.n += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: nd(pdfLines),
    });
  });
  return hits;
}

/**
 * Answers every mint. `answer(n)` decides call number n (1-based): a session,
 * or an error. Returns the live count.
 */
async function stubMint(
  page: Page,
  answer: (n: number) => { status: number; body: unknown } = () => ({
    status: 200,
    body: SESSION,
  }),
) {
  const count = { n: 0 };
  await page.route("**/api/realtime/session", (route: Route) => {
    count.n += 1;
    const { status, body } = answer(count.n);
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return count;
}

const rateLimited = (seconds: number) => ({
  status: 429,
  body: { error: { code: "rate_limited", retryAfterSec: seconds } },
});

async function openChat(
  page: Page,
  query: string,
  mode: "voice" | "text" = "voice",
) {
  await page.goto(`/?mockRealtime=normal-turn&mockMint=route&${query}`);
  await page.getByRole("button", { name: "Sample PDF" }).click();
  await page
    .getByRole("button", {
      name: mode === "voice" ? "Start voice chat" : "Type instead",
    })
    .click();
}

const pill = (page: Page) => page.getByTestId("status-pill");
const notice = (page: Page) => page.getByTestId("reconnect-notice");
const divider = (page: Page) => page.getByTestId("reconnected-divider");
const failure = (page: Page) => page.getByTestId("failure-card");

test.describe("a voice chat on a bad network", () => {
  test.beforeEach(async ({ page }) => {
    await stubMic(page);
    await stubPdfIngest(page);
  });

  test("a drop that heals inside the grace period needs no new session", async ({
    page,
  }) => {
    const mints = await stubMint(page);
    await openChat(page, "mockNet=drop-recover");
    await expect(pill(page)).toHaveText(/Listening|You're speaking/, {
      timeout: 10_000,
    });

    await expect(notice(page)).toHaveAttribute("data-phase", "grace", {
      timeout: 5_000,
    });
    await expect(pill(page)).toHaveText("Reconnecting");
    await expect(notice(page)).toBeHidden({ timeout: 8_000 });
    await expect(pill(page)).toHaveText(
      /Listening|You're speaking|Thinking|Speaking/,
    );

    await expect(divider(page)).toHaveCount(0);
    expect(mints.n).toBe(1);
  });

  test("a drop that never heals reconnects after the grace period with exactly one new secret", async ({
    page,
  }) => {
    const mints = await stubMint(page);
    await openChat(page, "mockNet=drop-timeout");
    await expect(notice(page)).toBeVisible({ timeout: 10_000 });
    expect(mints.n).toBe(1);

    await expect(divider(page)).toBeVisible({ timeout: 20_000 });
    await expect(notice(page)).toBeHidden();
    expect(mints.n).toBe(2);
  });

  test("a failed link reconnects at once", async ({ page }) => {
    const mints = await stubMint(page);
    await openChat(page, "mockNet=failed");
    await expect(divider(page)).toBeVisible({ timeout: 15_000 });
    expect(mints.n).toBe(2);
    await expect(pill(page)).toHaveText(
      /Listening|You're speaking|Thinking|Speaking/,
    );
  });

  test("a session-expired error from the server takes the same road", async ({
    page,
  }) => {
    const mints = await stubMint(page);
    await openChat(page, "mockNet=expired");
    await expect(divider(page)).toBeVisible({ timeout: 15_000 });
    expect(mints.n).toBe(2);
  });

  test("a connection that stays dead ends in Connection lost, with Reconnect and Switch to text", async ({
    page,
  }) => {
    const mints = await stubMint(page);
    await openChat(page, "mockNet=dead");

    await expect(failure(page)).toBeVisible({ timeout: 30_000 });
    await expect(failure(page)).toHaveAttribute(
      "data-code",
      "session_reconnect_failed",
    );
    await expect(failure(page)).toContainText("Connection lost");
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Switch to text" }),
    ).toBeVisible();
    await expect(pill(page)).toHaveText("Not connected");
    // The chat's own secret and one per automatic attempt, never more.
    expect(mints.n).toBe(4);
    await page.waitForTimeout(3_000);
    expect(mints.n).toBe(4);

    await page.getByRole("button", { name: "Switch to text" }).click();
    await expect(page.getByPlaceholder("Ask a question")).toBeVisible({
      timeout: 10_000,
    });
    expect(mints.n).toBe(5);
  });

  test("a 429 while reconnecting is a Cooldown that counts down and then resumes", async ({
    page,
  }) => {
    const mints = await stubMint(page, (n) =>
      n === 2 ? rateLimited(4) : { status: 200, body: SESSION },
    );
    await openChat(page, "mockNet=failed");

    await expect(notice(page)).toHaveAttribute("data-phase", "cooldown", {
      timeout: 15_000,
    });
    await expect(pill(page)).toHaveText("Cooldown");
    await expect(notice(page)).toContainText(/Reconnecting in \d+s/);
    expect(mints.n).toBe(2);

    await expect(divider(page)).toBeVisible({ timeout: 15_000 });
    // The 429 used its attempt; one more mint, not a loop.
    expect(mints.n).toBe(3);
    await page.waitForTimeout(2_000);
    expect(mints.n).toBe(3);
  });

  test("a daily limit while reconnecting is final", async ({ page }) => {
    const mints = await stubMint(page, (n) =>
      n === 2
        ? {
            status: 429,
            body: { error: { code: "daily_limit", retryAfterSec: 3600 } },
          }
        : { status: 200, body: SESSION },
    );
    await openChat(page, "mockNet=failed");
    await expect(failure(page)).toHaveAttribute("data-code", "daily_limit", {
      timeout: 15_000,
    });
    await expect(pill(page)).toHaveText("Daily limit reached");
    await page.waitForTimeout(3_000);
    expect(mints.n).toBe(2);
  });

  test("an expired document offers Load it again, which loads the same source", async ({
    page,
  }) => {
    const mints = await stubMint(page, (n) =>
      n === 2
        ? { status: 404, body: { error: { code: "doc_not_found" } } }
        : { status: 200, body: SESSION },
    );
    const ingest = await stubPdfIngest(page);
    await openChat(page, "mockNet=failed");

    await expect(failure(page)).toHaveAttribute("data-code", "doc_not_found", {
      timeout: 15_000,
    });
    expect(ingest.n).toBe(1);
    await page.getByRole("button", { name: "Load it again" }).click();

    // The document is read again from the source the page still holds.
    await expect(
      page.getByRole("button", { name: "Start voice chat" }),
    ).toBeEnabled({ timeout: 10_000 });
    expect(ingest.n).toBe(2);
    expect(mints.n).toBe(2);
  });

  test("a microphone that ends is replaced without a new session", async ({
    page,
  }) => {
    const mints = await stubMint(page);
    await openChat(page, "");
    await expect(pill(page)).toHaveText(/Listening|You're speaking/, {
      timeout: 10_000,
    });

    await page.evaluate(() => {
      const w = window as MicWindow;
      // What the browser does when the device goes away.
      w.__streams?.[0]?.getAudioTracks()[0]?.dispatchEvent(new Event("ended"));
    });
    await expect
      .poll(() => page.evaluate(() => (window as MicWindow).__micCalls))
      .toBe(2);
    // Still a voice chat: no text-mode banner, and no new secret.
    await expect(page.getByTestId("mic-banner")).toHaveCount(0);
    expect(mints.n).toBe(1);
  });
});

test.describe("loading on a bad network", () => {
  const meta = {
    documentId: "doc-1",
    title: "Me at the zoo",
    sourceType: "youtube",
    videoId: "jNQXAC9IVRw",
    thumbnailUrl: "/favicon.ico",
    channel: "jawed",
    durationSec: 19,
    language: "en",
    isAutoGenerated: false,
    provider: "direct",
    cached: false,
  };
  const full = nd([
    meta,
    { segment: { startSec: 0, text: "All right, so here we are" } },
    { done: true, stats: { segments: 1, words: 6, tokens: 8 }, coverage: 1 },
  ]);
  const cut = nd([
    meta,
    { segment: { startSec: 0, text: "All right, so here" } },
  ]);

  async function loadVideo(page: Page) {
    await page.goto("/");
    await page.getByRole("radio", { name: "YouTube" }).click();
    await page.getByLabel("YouTube link").fill("https://youtu.be/jNQXAC9IVRw");
    await page.getByLabel("YouTube link").press("Enter");
  }

  test("one aborted request is retried by itself", async ({ page }) => {
    let hits = 0;
    await page.route("**/api/ingest/youtube", (route) => {
      hits += 1;
      return hits === 1
        ? route.abort("connectionreset")
        : route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: full,
          });
    });
    await loadVideo(page);
    await expect(
      page.getByRole("heading", { name: "Me at the zoo" }),
    ).toBeVisible({ timeout: 15_000 });
    expect(hits).toBe(2);
  });

  test("a request that keeps failing ends with Try again, which works once the network does", async ({
    page,
  }) => {
    let up = false;
    await page.route("**/api/ingest/youtube", (route) =>
      up
        ? route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: full,
          })
        : route.abort("connectionreset"),
    );
    await loadVideo(page);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      // A connection that never answered is said as offline, not as a video problem.
      page
        .getByRole("alert")
        .filter({ hasText: "offline or the network dropped" }),
    ).toBeVisible();

    up = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("heading", { name: "Me at the zoo" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("a stream cut before the end keeps what arrived and offers Try again", async ({
    page,
  }) => {
    let whole = false;
    let hits = 0;
    await page.route("**/api/ingest/youtube", (route) => {
      hits += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: whole ? full : cut,
      });
    });
    await loadVideo(page);

    const partial = page.getByTestId("partial-notice");
    await expect(partial).toBeVisible({ timeout: 15_000 });
    await expect(partial).toContainText("The connection dropped.");
    // The first try plus the one silent retry.
    expect(hits).toBe(2);
    // What arrived is still on screen.
    await expect(
      page.getByRole("heading", { name: "Me at the zoo" }),
    ).toBeVisible();
    await expect(page.getByText("All right, so here")).toBeVisible();

    whole = true;
    await partial.getByRole("button", { name: "Try again" }).click();
    await expect(partial).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText("All right, so here we are")).toBeVisible();
  });

  test("going offline shows the banner, and the load resumes when the connection is back", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "setOffline does not raise the offline event in WebKit",
    );
    // A route answers even while the context is offline, so it fails the
    // request itself, as a dead network would.
    let reachable = true;
    await page.route("**/api/ingest/youtube", (route) =>
      reachable
        ? route.fulfill({
            status: 200,
            contentType: "application/x-ndjson",
            body: full,
          })
        : route.abort("internetdisconnected"),
    );
    await page.goto("/");
    reachable = false;
    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await expect(page.getByTestId("offline-banner")).toContainText(
      "You're offline. We'll reconnect when you're back.",
    );

    await page.getByRole("radio", { name: "YouTube" }).click();
    await page.getByLabel("YouTube link").fill("https://youtu.be/jNQXAC9IVRw");
    await page.getByLabel("YouTube link").press("Enter");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({
      timeout: 15_000,
    });

    reachable = true;
    await context.setOffline(false);
    await expect(page.getByTestId("offline-banner")).toBeHidden({
      timeout: 10_000,
    });
    // Nobody tapped anything: the pending load ran again by itself.
    await expect(
      page.getByRole("heading", { name: "Me at the zoo" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Load it again on a YouTube source shows the load working, not the old document with live buttons", async ({
    page,
  }) => {
    let ingestHits = 0;
    await page.route("**/api/ingest/youtube", async (route) => {
      ingestHits += 1;
      // The second load is slow enough to be seen.
      if (ingestHits === 2) await new Promise((r) => setTimeout(r, 2_000));
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: full,
      });
    });
    let mints = 0;
    await page.route("**/api/realtime/session", (route) => {
      mints += 1;
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "doc_not_found" } }),
      });
    });
    await page.goto("/?mockRealtime=normal-turn&mockMint=route");
    await page.getByRole("radio", { name: "YouTube" }).click();
    await page.getByLabel("YouTube link").fill("https://youtu.be/jNQXAC9IVRw");
    await page.getByLabel("YouTube link").press("Enter");
    await page.getByRole("button", { name: "Type instead" }).click();
    await expect(page.getByTestId("failure-card")).toHaveAttribute(
      "data-code",
      "doc_not_found",
      { timeout: 10_000 },
    );

    await page.getByRole("button", { name: "Load it again" }).click();
    // While it loads: a visible working state, and no live buttons for the old document.
    await expect(page.getByText("Fetching captions…")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Load it again" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Type instead" }),
    ).toHaveCount(0);
    // Then the document is back.
    await expect(
      page.getByRole("heading", { name: "Me at the zoo" }),
    ).toBeVisible({ timeout: 10_000 });
    expect(ingestHits).toBe(2);
    expect(mints).toBe(1);
  });

  test("going offline during a chat is announced once", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "setOffline does not raise the offline event in WebKit",
    );
    await stubMic(page);
    await stubPdfIngest(page);
    await stubMint(page);
    await openChat(page, "");
    await expect(pill(page)).toHaveText(/Listening|You're speaking/, {
      timeout: 10_000,
    });
    await context.setOffline(true);
    // One banner, and it is the chat's, not the page behind it.
    await expect(page.getByTestId("offline-banner")).toHaveCount(1);
    await expect(
      page.getByTestId("conversation").getByTestId("offline-banner"),
    ).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  });

  test("an upload that stops moving says Connection is slow, and offers Cancel and Keep waiting", async ({
    page,
  }) => {
    // Holds the first call of the upload (which mode to use) so nothing moves.
    await page.route("**/api/health", () => {});
    await page.goto("/?mockStallMs=1500");
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(2048, 32),
    ]);
    await page.locator('input[type="file"]').setInputFiles({
      name: "slow.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });

    const status = page
      .getByRole("status")
      .filter({ hasText: /Uploading|Connection is slow/ });
    await expect(status).toContainText("Connection is slow", {
      timeout: 8_000,
    });
    await expect(page.getByRole("progressbar")).toBeVisible();

    await page.getByRole("button", { name: "Keep waiting" }).click();
    await expect(status).toContainText("Uploading…");
    await expect(status).toContainText("Connection is slow", {
      timeout: 8_000,
    });

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Choose a PDF")).toBeVisible();
  });
});
