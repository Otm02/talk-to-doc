// What to tap to give the page its microphone back. Browsers show no prompt
// once a site is blocked, and "allow the mic in your browser settings" leaves
// a phone user hunting; these are the actual taps. The first line depends on
// the browser, which the user agent tells us well enough for copy.

export type CoachBrowser =
  | "chrome-android"
  | "samsung"
  | "chrome"
  | "ios-safari"
  | "ios-other"
  | "other";

export function detectBrowser(userAgent: string): CoachBrowser {
  // Samsung Internet also says "Chrome", so it goes first.
  if (/SamsungBrowser/i.test(userAgent)) return "samsung";
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    // Every iOS browser is WebKit, but only Safari has the page menu.
    return /CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent)
      ? "ios-other"
      : "ios-safari";
  }
  if (/Chrome\//.test(userAgent) && !/Edg|OPR\//.test(userAgent)) {
    return /Android/i.test(userAgent) ? "chrome-android" : "chrome";
  }
  return "other";
}

export interface Coach {
  /** In order. The last one sends the user back to the retry button: a reload would lose the document and the chat. */
  steps: string[];
  /** For when the site setting already says Allow but the mic still fails. */
  fallback: string;
}

const COME_BACK =
  "Come back and tap 'Try microphone again' (reload only if your browser prompts you).";

const SITE_STEPS = ["Open Permissions.", "Set Microphone to Allow.", COME_BACK];

export function micCoach(userAgent: string): Coach {
  const browser = detectBrowser(userAgent);
  switch (browser) {
    case "chrome-android":
      return {
        steps: ["Tap the tune icon left of the address bar.", ...SITE_STEPS],
        fallback:
          "Already allowed? Open Android Settings, then Apps, Chrome, Permissions, Microphone.",
      };
    case "samsung":
      return {
        steps: ["Tap the lock icon left of the address bar.", ...SITE_STEPS],
        fallback:
          "Already allowed? Open Android Settings, then Apps, Samsung Internet, Permissions, Microphone.",
      };
    case "chrome":
      return {
        steps: ["Click the tune icon left of the address bar.", ...SITE_STEPS],
        fallback:
          "Already allowed? Check that your system settings let Chrome use the microphone.",
      };
    case "ios-safari":
      return {
        steps: [
          "Tap the page menu at the left of the address bar.",
          "Open Website Settings.",
          "Set Microphone to Allow.",
          COME_BACK,
        ],
        fallback:
          "Already allowed? Open Settings, then Apps, Safari, Microphone.",
      };
    case "ios-other":
      return {
        steps: [
          "Open the Settings app, then Apps, and choose this browser.",
          "Turn on Microphone.",
          COME_BACK,
        ],
        fallback:
          "Still blocked? Try Safari, where the page menu has a Microphone setting.",
      };
    case "other":
      return {
        steps: [
          "Tap the lock or tune icon left of the address bar.",
          ...SITE_STEPS,
        ],
        fallback:
          "Already allowed? Check that your device settings let this browser use the microphone.",
      };
    default: {
      const unreachable: never = browser;
      return unreachable;
    }
  }
}
