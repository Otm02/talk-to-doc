import { describe, expect, it } from "vitest";
import { detectBrowser, micCoach } from "./mic-coach";

// Real user agents (shortened only in the device/build part).
const UA = {
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 16; SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 16; SAMSUNG SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36",
  chromeDesktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1",
  firefoxAndroid:
    "Mozilla/5.0 (Android 16; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0",
};

describe("detectBrowser", () => {
  it.each([
    [UA.chromeAndroid, "chrome-android"],
    // Samsung Internet's UA contains "Chrome" too; it must not read as Chrome.
    [UA.samsung, "samsung"],
    [UA.chromeDesktop, "chrome"],
    [UA.edge, "other"],
    [UA.iosSafari, "ios-safari"],
    [UA.iosChrome, "ios-other"],
    [UA.firefoxAndroid, "other"],
    ["", "other"],
  ] as const)("reads %s as %s", (ua, browser) => {
    expect(detectBrowser(ua)).toBe(browser);
  });
});

describe("micCoach", () => {
  it("tells Chrome on Android to use the tune icon, then the Android app setting", () => {
    expect(micCoach(UA.chromeAndroid)).toEqual({
      steps: [
        "Tap the tune icon left of the address bar.",
        "Open Permissions.",
        "Set Microphone to Allow.",
        "Come back and tap 'Try microphone again' (reload only if your browser prompts you).",
      ],
      fallback:
        "Already allowed? Open Android Settings, then Apps, Chrome, Permissions, Microphone.",
    });
  });

  it("tells Samsung Internet to use the lock icon, and names its own app setting", () => {
    const coach = micCoach(UA.samsung);
    expect(coach.steps[0]).toBe("Tap the lock icon left of the address bar.");
    expect(coach.steps.slice(1)).toEqual([
      "Open Permissions.",
      "Set Microphone to Allow.",
      "Come back and tap 'Try microphone again' (reload only if your browser prompts you).",
    ]);
    expect(coach.fallback).toBe(
      "Already allowed? Open Android Settings, then Apps, Samsung Internet, Permissions, Microphone.",
    );
  });

  it("names both icons when it cannot tell the browser", () => {
    expect(micCoach(UA.firefoxAndroid).steps[0]).toBe(
      "Tap the lock or tune icon left of the address bar.",
    );
  });

  it("does not send an iPhone to Android settings", () => {
    for (const ua of [UA.iosSafari, UA.iosChrome]) {
      const text = JSON.stringify(micCoach(ua));
      expect(text).not.toContain("Android");
      expect(text).toContain("Microphone");
    }
    expect(micCoach(UA.iosSafari).steps[1]).toBe("Open Website Settings.");
  });

  it("always ends by sending the user back to the retry button, never to a reload that loses the chat", () => {
    for (const ua of Object.values(UA)) {
      expect(micCoach(ua).steps.at(-1)).toMatch(
        /^Come back and tap 'Try microphone again'/,
      );
    }
    expect(micCoach(UA.chromeDesktop).steps[0]).toMatch(/^Click the tune icon/);
  });
});
