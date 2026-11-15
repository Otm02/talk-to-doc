import { expect, type Page } from "@playwright/test";

// Helpers for the review-script journeys. The older specs keep their own
// copies; these are the ones to import in new tests.

export type MicMode = "ok" | "denied";
type MicWindow = Window & { __mic?: MicMode; __micCalls?: number };

/**
 * getUserMedia and the Permissions API, both answering from `window.__mic`,
 * so a test can deny the mic at the start and allow it later (setMic). It sets
 * the method on the prototype and the permissions object on navigator itself,
 * because WebKit drops or ignores the other ways of doing it.
 */
export async function stubMic(page: Page, mode: MicMode) {
  await page.addInitScript((m) => {
    const w = window as MicWindow;
    w.__mic = m;
    w.__micCalls = 0;
    if (typeof MediaDevices === "undefined") return;
    MediaDevices.prototype.getUserMedia = async () => {
      w.__micCalls = (w.__micCalls ?? 0) + 1;
      if (w.__mic === "denied") throw new DOMException("no", "NotAllowedError");
      return new AudioContext().createMediaStreamDestination().stream;
    };
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: async () =>
          ({
            state: w.__mic === "denied" ? "denied" : "granted",
          }) as PermissionStatus,
      },
    });
  }, mode);
}

export const setMic = (page: Page, mode: MicMode) =>
  page.evaluate((m) => void ((window as MicWindow).__mic = m), mode);

/** Requests to our own API (or OpenAI) made from now on, with their paths. */
export function watchApi(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") || /openai\.com$/.test(u.hostname)) {
      seen.push(`${r.method()} ${u.pathname}`);
    }
  });
  return seen;
}

export const ndjson = (...lines: unknown[]) =>
  lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

export const pill = (page: Page) => page.getByTestId("status-pill");
export const answers = (page: Page) => page.getByTestId("item-assistant");
export const users = (page: Page) => page.getByTestId("item-user");

/** Reads a download to a string. */
export async function readDownload(download: {
  createReadStream(): Promise<NodeJS.ReadableStream>;
}): Promise<string> {
  let text = "";
  for await (const chunk of await download.createReadStream()) {
    text += String(chunk);
  }
  return text;
}

/** The soft keyboard on a 390x844 phone leaves about this much. */
export async function showKeyboard(page: Page, height = 420) {
  await page.setViewportSize({ width: 390, height });
  await expect
    .poll(() =>
      page.evaluate(() => window.visualViewport?.height ?? window.innerHeight),
    )
    .toBe(height);
}
