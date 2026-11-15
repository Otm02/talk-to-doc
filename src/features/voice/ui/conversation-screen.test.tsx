// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, type HarnessOptions } from "@test/realtime/harness";
import type { DocumentData } from "@/features/ingest/ingest-state";
import { OfflineBanner } from "@/components/offline-banner";
import { MintError } from "../realtime/mint";
import { scenarioScript } from "../realtime/mock-scenarios";
import { MIC_RETRY_MIN_MS } from "../realtime/session";
import type { Mode } from "../realtime/state";
import { useVoiceSession } from "../realtime/use-voice-session";
import { ConversationScreen } from "./conversation-screen";

// The whole chat screen on the real engine, with fake browser dependencies
// and the mock transport. No network exists here: `fetch` is a spy that must
// stay untouched, and the harness counts every secret that is minted.

const DOC: DocumentData = {
  meta: {
    documentId: "doc-1",
    title: "Annual report 2025",
    sourceType: "pdf",
    pages: 12,
  },
  fileName: "annual-report-2025.pdf",
  pages: Array.from({ length: 12 }, (_, i) => ({
    page: i + 1,
    text: `Text of page ${i + 1}.`,
  })),
  segments: [],
  done: {
    done: true,
    stats: { pages: 12, words: 48, tokens: 60 },
    coverage: 1,
  },
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 14, 12, 0, 0));
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = (ms = 50) =>
  act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** findBy* polls on real timers, which are faked here: settle, then look. */
async function found<T>(get: () => T): Promise<T> {
  await settle();
  return get();
}
const tap = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const pill = () => screen.getByTestId("status-pill");
const layout = () =>
  screen.getByTestId("conversation").getAttribute("data-layout");

describe("ConversationScreen", () => {
  // The first start normally comes from the document screen's buttons; here a
  // plain button stands in for them, wired to the same session as the screen.
  async function start(
    mode: Mode,
    options: HarnessOptions = {},
    onReloadSource?: () => void,
  ) {
    const h = makeHarness(options);
    const onClose = vi.fn();
    function Auto() {
      const session = useVoiceSession("doc-1", { deps: h.deps });
      return (
        <>
          <button onClick={() => session.actions.start(mode)}>
            test-start
          </button>
          {/* The page behind the chat, as AppShell renders it. */}
          <OfflineBanner hideWhenChatOpen />
          <ConversationScreen
            doc={DOC}
            session={session}
            onStart={(m: Mode) => session.actions.start(m)}
            onReloadSource={onReloadSource}
            onEnd={() => session.actions.end()}
            onClose={onClose}
          />
        </>
      );
    }
    render(<Auto />);
    tap("test-start");
    await settle();
    return { h, onClose };
  }

  describe("the microphone coach", () => {
    it("a retry that is still denied makes zero requests and keeps the button", async () => {
      const { h } = await start("voice", { mic: "denied" });
      const banner = screen.getByTestId("mic-banner");
      expect(banner).toHaveTextContent(
        "Microphone unavailable, you're in text mode",
      );
      expect(screen.queryByTestId("mic-coach")).toBeNull();
      expect(h.mint).toHaveBeenCalledOnce(); // the chat's own secret
      h.requestMic.mockClear();
      // The browser now reports the block outright.
      h.setMic("denied", "denied");

      tap("Try microphone again");
      await settle(10);

      // Nothing went over the network and nothing was minted.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(h.mint).toHaveBeenCalledOnce();
      expect(h.requestMic).not.toHaveBeenCalled();
      expect(h.transports).toHaveLength(1);
      // The chat is still there, the button is still there, and the coach opened.
      expect(pill()).toHaveTextContent("Ready");
      expect(
        screen.getByRole("button", { name: "Try microphone again" }),
      ).toBeEnabled();
      const coach = screen.getByTestId("mic-coach");
      expect(
        within(coach)
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual([
        "Tap the lock or tune icon left of the address bar.",
        "Open Permissions.",
        "Set Microphone to Allow.",
        "Come back and tap 'Try microphone again' (reload only if your browser prompts you).",
      ]);
      expect(coach).toHaveTextContent(/Already allowed\?/);
    });

    it.each(["denied", "not_found", "in_use"] as const)(
      "getUserMedia failing with %s: same story, however often it is tapped",
      async (reason) => {
        const { h } = await start("voice", { mic: reason });
        h.setMic(reason, "prompt");
        for (let i = 0; i < 6; i += 1) {
          tap("Try microphone again");
          await settle(MIC_RETRY_MIN_MS);
        }
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(h.mint).toHaveBeenCalledOnce();
        expect(h.transports).toHaveLength(1);
        expect(screen.getByTestId("mic-banner")).toHaveAttribute(
          "data-reason",
          reason,
        );
        expect(
          screen.getByRole("button", { name: "Try microphone again" }),
        ).toBeEnabled();
        expect(screen.getByTestId("mic-coach")).toBeInTheDocument();
        // No failure card: the chat itself never failed.
        expect(screen.queryByTestId("failure-card")).toBeNull();
      },
    );

    it("shows that it is checking, and ignores taps meanwhile", async () => {
      const { h } = await start("voice", { mic: "denied" });
      h.requestMic.mockClear();
      h.setMic("pending", "prompt");
      tap("Try microphone again");
      await settle(10);
      const busy = screen.getByRole("button", { name: "Checking microphone…" });
      expect(busy).toHaveAttribute("aria-busy", "true");
      fireEvent.click(busy);
      fireEvent.click(busy);
      await settle(3000);
      expect(h.requestMic).toHaveBeenCalledOnce();
      expect(h.mint).toHaveBeenCalledOnce();
    });

    it("a mic that now works is attached in place: no new secret, back to the voice layout", async () => {
      const { h } = await start("voice", { mic: "denied" });
      expect(layout()).toBe("compact");
      h.setMic("ok", "granted");

      tap("Try microphone again");
      await settle(10);

      // replaceTrack path: the stream went into the transport already open.
      expect(h.transport.micUpgrades).toEqual([h.micStreams.at(-1)]);
      expect(h.transports).toHaveLength(1);
      expect(h.mint).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId("mic-banner")).toBeNull();
      expect(pill()).toHaveTextContent("Listening");
      expect(layout()).toBe("full");
      expect(screen.getByTestId("orb")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mute" })).toBeEnabled();
    });

    it("the composer's mic button does the same in a chat started as text", async () => {
      const { h } = await start("text");
      expect(screen.queryByTestId("mic-banner")).toBeNull();
      tap("Turn on microphone");
      await settle(10);
      expect(h.transport.micUpgrades).toHaveLength(1);
      expect(h.mint).toHaveBeenCalledOnce();
      expect(pill()).toHaveTextContent("Listening");
    });

    it("lets the user open and close the steps by hand", async () => {
      await start("voice", { mic: "denied" });
      const toggle = screen.getByRole("button", { name: "How to allow it" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(screen.getByTestId("mic-coach")).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(toggle);
      expect(screen.queryByTestId("mic-coach")).toBeNull();
    });
  });

  describe("the compact layout", () => {
    it("a voice chat is roomy until the composer opens, then folds everything away", async () => {
      await start("voice");
      expect(layout()).toBe("full");
      expect(screen.getByTestId("orb")).toBeInTheDocument();
      expect(
        screen.getByRole("toolbar", { name: "Chat controls" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("debug-strip")).toBeInTheDocument();
      expect(screen.queryByTestId("level-dot")).toBeNull();
      const timer = screen.getByTestId("session-timer");

      tap("Keyboard");

      expect(layout()).toBe("compact");
      // The orb became a dot inside the pill, which moved into the header.
      expect(screen.queryByTestId("orb")).toBeNull();
      expect(within(pill()).getByTestId("level-dot")).toBeInTheDocument();
      expect(pill().closest("header")).not.toBeNull();
      // The control bar folded into the composer row: mic toggle, send, end.
      expect(screen.queryByRole("toolbar")).toBeNull();
      const row = screen.getByTestId("composer-row");
      expect(
        within(row)
          .getAllByRole("button")
          .map((b) => b.getAttribute("aria-label")),
      ).toEqual(["Mute", "Send", "End"]);
      // The debug strip is hidden, the timer is the same element (still counting).
      expect(screen.queryByTestId("debug-strip")).toBeNull();
      expect(screen.getByTestId("session-timer")).toBe(timer);

      // Mute works from the row, and the dot gives way to the muted icon.
      fireEvent.click(within(row).getByRole("button", { name: "Mute" }));
      expect(pill()).toHaveTextContent("Muted");
      expect(screen.queryByTestId("level-dot")).toBeNull();
      expect(
        within(row).getByRole("button", { name: "Unmute" }),
      ).toHaveAttribute("aria-pressed", "true");
    });

    it("keeps the debug tools reachable from the overflow menu, and can hide the keyboard again", async () => {
      await start("voice");
      tap("Keyboard");
      tap("More");
      const menu = await found(() => screen.getByTestId("session-menu"));
      expect(within(menu).getByTestId("menu-debug")).toContainElement(
        within(menu).getByTestId("cost-overlay"),
      );
      expect(
        within(menu).getByRole("button", { name: "Events" }),
      ).toBeInTheDocument();

      fireEvent.click(
        within(menu).getByRole("button", { name: "Hide keyboard" }),
      );
      await settle(300);
      expect(layout()).toBe("full");
      expect(screen.getByTestId("orb")).toBeInTheDocument();
    });

    it("a new chat opens roomy, with no composer and no soft keyboard, after one that used the keyboard", async () => {
      await start("voice");
      tap("Keyboard");
      expect(screen.getByTestId("composer")).toBeInTheDocument();
      tap("End");
      fireEvent.click(
        await found(() => screen.getByRole("button", { name: "End chat" })),
      );
      await settle();
      expect(screen.getByTestId("ended-panel")).toBeInTheDocument();

      tap("Start a new chat");
      await settle();

      expect(pill()).toHaveTextContent(/Listening|Connecting/);
      expect(screen.queryByTestId("composer")).toBeNull();
      expect(layout()).toBe("full");
      expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
    });

    it("text mode is always compact, with End asking first", async () => {
      const { h } = await start("text");
      expect(layout()).toBe("compact");
      expect(screen.queryByTestId("orb")).toBeNull();
      expect(screen.queryByTestId("level-dot")).toBeNull(); // no mic, no meter
      expect(pill()).toHaveTextContent("Ready");
      const row = screen.getByTestId("composer-row");
      expect(
        within(row)
          .getAllByRole("button")
          .map((b) => b.getAttribute("aria-label")),
      ).toEqual(["Turn on microphone", "Send", "End"]);

      fireEvent.click(within(row).getByRole("button", { name: "End" }));
      fireEvent.click(
        await found(() => screen.getByRole("button", { name: "Keep talking" })),
      );
      expect(pill()).not.toHaveTextContent("Ended");
      fireEvent.click(within(row).getByRole("button", { name: "End" }));
      fireEvent.click(
        await found(() => screen.getByRole("button", { name: "End chat" })),
      );
      expect(pill()).toHaveTextContent("Ended");
      expect(h.transport.closeCount).toBe(1);
    });

    it("turns Send into Stop while an answer is coming and nothing is typed", async () => {
      const { h } = await start("text", {
        script: { ...scenarioScript("text-turn"), wordMs: 500 },
      });
      const input = screen.getByTestId("composer");
      fireEvent.change(input, { target: { value: "What is this about?" } });
      tap("Send");
      await settle(700);
      const stop = screen.getByRole("button", { name: "Stop answer" });
      // Typing brings Send back: a new question replaces the answer anyway.
      fireEvent.change(input, { target: { value: "x" } });
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.click(
        stop.isConnected
          ? stop
          : screen.getByRole("button", { name: "Stop answer" }),
      );
      expect(h.transport.sent.some((e) => e.type === "response.cancel")).toBe(
        true,
      );
      await settle(500);
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });

    it("shows the time warning inside the transcript area, not above it", async () => {
      await start("text", { session: { maxSessionSeconds: 90 } });
      await settle(31_000);
      const warning = screen.getByTestId("time-warning");
      expect(screen.getByTestId("transcript-region")).toContainElement(warning);
    });
  });

  describe("a chat that could not start", () => {
    it("a per-IP 429 is a Cooldown with a live countdown, not Offline", async () => {
      const { h } = await start("voice", {
        mintError: new MintError("rate_limited", 72),
      });
      expect(pill()).toHaveTextContent("Cooldown");
      expect(pill()).not.toHaveTextContent("Offline");
      const retry = screen.getByTestId("retry-button");
      expect(retry).toBeDisabled();
      expect(retry).toHaveTextContent(/Try again in 1m 1[12]s/);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Too many tries. Try again when the timer ends.",
      );

      await settle(30_000);
      expect(retry).toHaveTextContent(/Try again in 4[12]s/);
      fireEvent.click(retry);
      expect(h.mint).toHaveBeenCalledOnce(); // a disabled retry mints nothing

      await settle(42_000);
      expect(retry).toBeEnabled();
      expect(retry).toHaveTextContent(/^Try again$/);
      expect(screen.getByTestId("retry-wait-end")).toHaveTextContent(
        "You can try again now.",
      );
      fireEvent.click(retry);
      await settle();
      expect(h.mint).toHaveBeenCalledTimes(2);
    });

    it.each([
      [new MintError("daily_limit", 7 * 3600), "Daily limit reached"],
      [new MintError("session_network_failed"), "Offline"],
      [new MintError("budget_exhausted"), "Unavailable"],
      [new MintError("voice_disabled"), "Unavailable"],
      [new MintError("session_upstream_busy"), "Not connected"],
      [new MintError("session_connect_failed"), "Not connected"],
    ])("%s reads as %s", async (mintError, label) => {
      await start("voice", { mintError });
      expect(pill()).toHaveTextContent(label);
      expect(screen.getByTestId("failure-card")).toBeInTheDocument();
      // No "say something" hint under a chat that is not running.
      expect(screen.queryByText(/Say something/)).toBeNull();
    });

    it("says Offline for any failure once the device itself is offline", async () => {
      await start("voice", { mintError: new MintError("rate_limited", 30) });
      expect(pill()).toHaveTextContent("Cooldown");
      vi.stubGlobal("navigator", {
        ...navigator,
        onLine: false,
        userAgent: "",
      });
      act(() => void window.dispatchEvent(new Event("offline")));
      expect(pill()).toHaveTextContent("Offline");
    });
  });

  describe("when the connection is lost", () => {
    async function lost() {
      const r = await start("voice", { script: scenarioScript("normal-turn") });
      await settle(3_000);
      expect(screen.getAllByTestId(/^item-(user|assistant)$/)).toHaveLength(2);
      r.h.mint.mockRejectedValue(new MintError("session_connect_failed"));
      r.h.transport.emitState("failed");
      await settle(15_000);
      return r;
    }

    it("offers Reconnect and Switch to text, and keeps the transcript on screen", async () => {
      await lost();
      expect(screen.getByTestId("failure-card")).toHaveAttribute(
        "data-code",
        "session_reconnect_failed",
      );
      expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Switch to text" }),
      ).toBeEnabled();
      expect(screen.getAllByTestId(/^item-(user|assistant)$/)).toHaveLength(2);
    });

    it("Reconnect goes on with the same conversation, with a Reconnected divider", async () => {
      const { h } = await lost();
      const minted = h.mint.mock.calls.length;
      h.mint.mockReset();
      h.mint.mockResolvedValue(h.response);
      tap("Reconnect");
      await settle(200);
      expect(h.mint).toHaveBeenCalledOnce();
      expect(h.mint.mock.calls[0]?.[2]).toHaveLength(2);
      expect(minted).toBeGreaterThan(1);
      expect(screen.queryByTestId("failure-card")).toBeNull();
      expect(screen.getByTestId("reconnected-divider")).toBeInTheDocument();
      expect(
        screen.getAllByTestId(/^item-(user|assistant)$/).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("Switch to text carries on in text, with the transcript and the composer", async () => {
      const { h } = await lost();
      h.mint.mockReset();
      h.mint.mockResolvedValue(h.response);
      tap("Switch to text");
      await settle(200);
      expect(screen.getByPlaceholderText("Ask a question")).toBeInTheDocument();
      expect(screen.queryByTestId("failure-card")).toBeNull();
      expect(
        screen.getAllByTestId(/^item-(user|assistant)$/).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("after a third 429 the countdown ends in a Retry that keeps the conversation, not a restart", async () => {
      const r = await start("voice", { script: scenarioScript("normal-turn") });
      await settle(3_000);
      r.h.mint.mockRejectedValue(new MintError("rate_limited", 5));
      r.h.transport.emitState("failed");
      await settle(20_000);
      const card = screen.getByTestId("failure-card");
      expect(card).toHaveAttribute("data-code", "rate_limited");
      expect(screen.getAllByTestId(/^item-(user|assistant)$/)).toHaveLength(2);

      r.h.mint.mockReset();
      r.h.mint.mockResolvedValue(r.h.response);
      const retry = screen.getByTestId("retry-button");
      expect(retry).toBeEnabled();
      fireEvent.click(retry);
      await settle(200);
      // The conversation went up as history; nothing was wiped.
      expect(r.h.mint.mock.calls[0]?.[2]).toHaveLength(2);
      expect(
        screen.getAllByTestId(/^item-(user|assistant)$/).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("a first start that is refused still starts over: there is nothing to keep", async () => {
      const r = await start("voice", {
        mintError: new MintError("rate_limited", 3),
      });
      expect(screen.getByTestId("failure-card")).toHaveAttribute(
        "data-code",
        "rate_limited",
      );
      r.h.mint.mockReset();
      r.h.mint.mockResolvedValue(r.h.response);
      await settle(3_100);
      fireEvent.click(screen.getByTestId("retry-button"));
      await settle(200);
      // A fresh chat: no history.
      expect(r.h.mint.mock.calls[0]?.[2]).toEqual([]);
    });
  });

  describe("going offline during a chat", () => {
    it("is announced once, by the chat, not also by the page behind it", async () => {
      await start("voice");
      vi.stubGlobal("navigator", {
        ...navigator,
        onLine: false,
        userAgent: "",
      });
      act(() => void window.dispatchEvent(new Event("offline")));
      const banners = screen.getAllByTestId("offline-banner");
      expect(banners).toHaveLength(1);
      expect(screen.getByTestId("conversation")).toContainElement(banners[0]!);
    });
  });

  describe("an expired document", () => {
    it("offers Load it again, and tapping it loads the same source again", async () => {
      const onReloadSource = vi.fn();
      await start(
        "voice",
        { mintError: new MintError("doc_not_found") },
        onReloadSource,
      );
      expect(screen.getByTestId("failure-card")).toHaveAttribute(
        "data-code",
        "doc_not_found",
      );
      tap("Load it again");
      expect(onReloadSource).toHaveBeenCalledOnce();
    });

    it("keeps the plain retry when the screen has no source to reload", async () => {
      await start("voice", { mintError: new MintError("doc_not_found") });
      expect(
        screen.queryByRole("button", { name: "Load it again" }),
      ).toBeNull();
      expect(screen.getByTestId("retry-button")).toHaveTextContent("Try again");
    });
  });

  describe("grounding chips", () => {
    it("turns page references in an answer into chips that open the text at that page", async () => {
      await start("voice", { script: scenarioScript("grounding") });
      await settle(8000);
      const answer = screen.getByTestId("item-assistant");
      const chips = within(answer).getAllByTestId("ref-chip");
      expect(chips.map((c) => c.textContent)).toEqual([
        "page 2",
        "pages 3 to 4",
      ]);
      // Page 40 does not exist: plain text. The user's own bubble: no chips.
      expect(answer).toHaveTextContent("Page 40 is not in this report.");
      expect(
        within(screen.getByTestId("item-user")).queryByTestId("ref-chip"),
      ).toBeNull();
      expect(chips[0]).toHaveAccessibleName("page 2, open in the full text");

      fireEvent.click(chips[1] as HTMLElement);
      const dialog = await found(() => screen.getByRole("dialog"));
      const page3 = within(dialog).getByRole("region", { name: "Page 3" });
      expect(page3).toHaveAttribute("data-highlight", "true");
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "start",
      });
      // A brief highlight: gone again shortly after.
      await settle(1700);
      expect(page3).not.toHaveAttribute("data-highlight");
    });
  });

  describe("transcript export", () => {
    it("copies the conversation as Markdown from the overflow menu", async () => {
      const writeText = vi.fn(async (text: string) => void text);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      await start("voice", { script: scenarioScript("normal-turn") });
      await settle(5000);

      tap("More");
      const menu = await found(() => screen.getByTestId("session-menu"));
      fireEvent.click(
        within(menu).getByRole("button", { name: "Copy transcript" }),
      );
      await settle(10);

      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText.mock.calls[0]?.[0]).toBe(
        [
          "# Annual report 2025",
          "",
          "- Source: annual-report-2025.pdf",
          "- Date: 2026-11-14",
          "- Model: gpt-realtime-2.1-mini",
          "",
          "**You:** What was revenue?",
          "",
          "**Assistant:** Revenue grew twelve percent last year.",
          "",
        ].join("\n"),
      );
      expect(
        within(menu).getByRole("button", { name: "Copied" }),
      ).toBeInTheDocument();
      await settle(3000);
      expect(
        within(menu).getByRole("button", { name: "Copy transcript" }),
      ).toBeInTheDocument();
    });

    it("says so when copying is not possible, and still offers Download", async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      await start("voice", { script: scenarioScript("normal-turn") });
      await settle(5000);
      tap("More");
      const menu = await found(() => screen.getByTestId("session-menu"));
      fireEvent.click(
        within(menu).getByRole("button", { name: "Copy transcript" }),
      );
      await settle(10);
      expect(
        within(menu).getByRole("button", {
          name: "Copy failed. Use Download.",
        }),
      ).toBeInTheDocument();
      expect(
        within(menu).getByRole("button", { name: "Download transcript" }),
      ).toBeEnabled();
    });

    it("offers Copy and Download in the ended state, and downloads <slug>-<date>.md", async () => {
      const create = vi.fn(() => "blob:fake");
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
      let saved = "";
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        function (this: HTMLAnchorElement) {
          saved = this.download;
        },
      );
      await start("voice", { script: scenarioScript("normal-turn") });
      await settle(5000);
      tap("End");
      fireEvent.click(
        await found(() => screen.getByRole("button", { name: "End chat" })),
      );

      const panel = screen.getByTestId("ended-panel");
      expect(within(panel).getByRole("button", { name: "Copy" })).toBeEnabled();
      fireEvent.click(within(panel).getByRole("button", { name: "Download" }));
      expect(saved).toBe("annual-report-2025-2026-11-14.md");
      expect(create).toHaveBeenCalledOnce();
      expect(
        within(panel).getByRole("button", { name: "Saved as Markdown" }),
      ).toBeInTheDocument();
    });

    it("has nothing to export from a chat with no messages", async () => {
      await start("text");
      tap("More");
      const menu = await found(() => screen.getByTestId("session-menu"));
      expect(
        within(menu).getByRole("button", { name: "Copy transcript" }),
      ).toBeDisabled();
      expect(
        within(menu).getByRole("button", { name: "Download transcript" }),
      ).toBeDisabled();
      // The document text is one tap away from here too.
      fireEvent.click(
        within(menu).getByRole("button", { name: "Show full text" }),
      );
      await settle(300);
      expect(
        within(
          await found(() => screen.getByRole("dialog", { name: "Full text" })),
        ).getByText("Page 1"),
      ).toBeInTheDocument();
    });
  });
});
