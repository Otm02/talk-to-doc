import { expect, test, type Page } from "@playwright/test";

// Runs against the production build (`next build` + `next start`, see
// playwright.config.ts), which is the only place a CSP breakage would show:
// `next dev` allows eval and its own inline scripts.

const BODY_LIMIT_IP = "203.0.113.201";

test.describe("security headers on the production build", () => {
  for (const path of ["/", "/api/health", "/no-such-page"]) {
    test(`${path} carries the full set`, async ({ request }) => {
      const res = await request.get(path);
      const h = res.headers();

      const csp = h["content-security-policy"] ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      // Dev-only allowances must not reach production.
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toMatch(/\bwss?:/);
      expect(csp).not.toContain("*.vercel.app");

      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["strict-transport-security"]).toContain("max-age=");
      expect(h["permissions-policy"]).toContain("microphone=(self)");
      expect(h["permissions-policy"]).toContain("camera=()");
    });
  }

  test("script-src allows inline scripts, because there is no nonce", async ({
    request,
  }) => {
    // Documented trade-off (docs/SECURITY.md): a nonce needs a proxy file, and
    // a proxy would buffer 25 MB uploads. Next's own bootstrap is inline.
    const csp = (await request.get("/")).headers()["content-security-policy"];
    const script = csp?.split("; ").find((d) => d.startsWith("script-src"));
    expect(script).toBe("script-src 'self' 'unsafe-inline'");
  });
});

type CspWindow = Window & { __csp?: string[] };

async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as CspWindow;
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp?.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const consoleHits: string[] = [];
  page.on("console", (m) => {
    if (
      /content security policy|refused to (load|execute|connect)/i.test(
        m.text(),
      )
    ) {
      consoleHits.push(m.text());
    }
  });
  return async () => [
    ...(await page.evaluate(() => (window as CspWindow).__csp ?? [])),
    ...consoleHits,
  ];
}

test.describe("the CSP does not break the app", () => {
  test("ingest, full text and a chat run with no violations", async ({
    page,
  }) => {
    const violations = await watchCsp(page);
    // Chat on the mock transport needs a mic stand-in, as in voice.spec.ts.
    await page.addInitScript(() => {
      if (typeof MediaDevices === "undefined") return;
      MediaDevices.prototype.getUserMedia = async () =>
        new AudioContext().createMediaStreamDestination().stream;
    });

    await page.goto("/?mockRealtime=normal-turn");
    // Hydration works only if Next's inline bootstrap scripts ran.
    await page.getByRole("button", { name: "Sample PDF" }).click();
    await expect(page.getByText("Whole document in context")).toBeVisible();

    await page.getByRole("button", { name: "Show full text" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Page 1", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close full text" }).click();

    await page.getByRole("button", { name: "Start voice chat" }).click();
    await expect(page.getByTestId("status-pill")).toHaveText(
      /Listening|You're speaking|Ready/,
      { timeout: 10_000 },
    );

    expect(await violations()).toEqual([]);
  });

  test("the YouTube form renders with no violations", async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Talk to a document" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "YouTube" }).click();
    await expect(page.getByLabel("YouTube link")).toBeVisible();
    expect(await violations()).toEqual([]);
  });
});

test.describe("connect-src, on the real page", () => {
  test("the two hosts the app talks to are reachable, any other is blocked", async ({
    page,
  }) => {
    const violations = await watchCsp(page);
    // The page never makes these calls on the mock transport, so make them
    // from the page's own origin and answer them locally: what is under test
    // is whether the policy lets the request out, not the hosts.
    const allow = { "access-control-allow-origin": "*" };
    await page.route("https://api.openai.com/**", (r) =>
      r.fulfill({ status: 200, headers: allow, body: "{}" }),
    );
    await page.route("https://vercel.com/api/blob/**", (r) =>
      r.fulfill({ status: 200, headers: allow, body: "{}" }),
    );
    await page.goto("/");

    const outcome = await page.evaluate(async () => {
      const hit = async (url: string) => {
        try {
          return (await fetch(url)).status;
        } catch {
          return "blocked";
        }
      };
      return {
        openai: await hit("https://api.openai.com/v1/realtime/calls"),
        blob: await hit("https://vercel.com/api/blob/?pathname=uploads/a.pdf"),
        other: await hit("https://example.com/exfiltrate"),
      };
    });

    expect(outcome).toEqual({ openai: 200, blob: 200, other: "blocked" });
    const seen = await violations();
    // The listener and the console both report the one blocked request.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatch(/connect-src.*example\.com/);
    for (const line of seen) {
      expect(line).toContain("example.com");
      expect(line).not.toMatch(/api\.openai\.com\/v1|vercel\.com\/api/);
    }
  });
});

test.describe("the CSP check can fail", () => {
  test("a stricter policy blocks Next's inline scripts and the watcher sees it", async ({
    page,
  }) => {
    // Proves the "no violations" tests above are not vacuous: serve the same
    // page with script-src 'self' only and the hydration scripts are refused.
    await page.route("**/", async (route) => {
      const res = await route.fetch();
      const csp = (res.headers()["content-security-policy"] ?? "").replace(
        "script-src 'self' 'unsafe-inline'",
        "script-src 'self'",
      );
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), "content-security-policy": csp },
      });
    });
    const violations = await watchCsp(page);
    await page.goto("/");
    await page.waitForLoadState("load");
    expect((await violations()).join("\n")).toMatch(/script-src/);
  });
});

test.describe("limits on the real server", () => {
  test("a burst gets 429 with Retry-After and retryAfterSec", async ({
    playwright,
    baseURL,
  }, testInfo) => {
    // One server serves every project and retry, and the limit lasts a
    // minute, so each run counts as its own client.
    const projectIndex = testInfo.project.name === "webkit" ? 2 : 1;
    const api = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        "x-forwarded-for": `198.18.${projectIndex}.${testInfo.retry + 1}`,
      },
    });
    let limited = 0;
    let last: Awaited<ReturnType<typeof api.get>> | undefined;
    for (let i = 0; i < 121; i += 1) {
      const res = await api.get("/api/health");
      if (res.status() === 429) {
        limited += 1;
        last = res;
      }
    }
    expect(limited).toBe(1);
    const header = Number(last?.headers()["retry-after"]);
    expect(header).toBeGreaterThanOrEqual(1);
    expect(header).toBeLessThanOrEqual(60);
    const body = (await last?.json()) as {
      error: { code: string; retryAfterSec: number };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfterSec).toBe(header);
    await api.dispose();
  });

  test("the cleanup cron refuses a caller without the secret", async ({
    request,
  }, testInfo) => {
    const res = await request.get("/api/cron/cleanup", {
      headers: {
        "x-forwarded-for": `198.18.${testInfo.project.name === "webkit" ? 4 : 3}.1`,
      },
    });
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  test("an oversized JSON body is refused as invalid_request", async ({
    playwright,
    baseURL,
  }) => {
    const api = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "x-forwarded-for": BODY_LIMIT_IP },
    });
    const res = await api.post("/api/ingest/youtube", {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({
        url: "https://youtu.be/dQw4w9WgXcQ",
        pad: "x".repeat(64 * 1024),
      }),
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    await api.dispose();
  });
});
