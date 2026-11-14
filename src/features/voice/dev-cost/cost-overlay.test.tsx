// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateCost } from "../realtime/cost";
import { EMPTY_USAGE, addResponseUsage } from "../realtime/usage";
import { CostOverlay } from "./cost-overlay";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/public-env");
  window.history.replaceState({}, "", "/");
});

const usage = addResponseUsage(EMPTY_USAGE, {
  input_token_details: {
    text_tokens: 119,
    audio_tokens: 13,
    cached_tokens: 64,
    cached_tokens_details: { text_tokens: 64 },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 91 },
});

describe("CostOverlay", () => {
  it("shows the session's tokens and estimated cost in development", () => {
    const cost = estimateCost("gpt-realtime-2.1-mini", usage);
    render(
      <CostOverlay cost={cost} model="gpt-realtime-2.1-mini" responses={1} />,
    );
    expect(screen.getByTestId("cost-total").textContent).toBe("$0.0021");
    expect(screen.getByTestId("cost-tokens").textContent).toBe("253 tok");
    expect(
      screen.getByText(/gpt-realtime-2.1-mini · 1 response$/),
    ).toBeInTheDocument();
    expect(screen.getByText("audio out")).toBeInTheDocument();
    expect(
      screen.getByText(/Prices as of 2026-11-09. Not sent anywhere./),
    ).toBeInTheDocument();
  });

  it("says so when there is no price table or no model yet", () => {
    render(<CostOverlay cost={null} model={null} responses={0} />);
    expect(screen.getByTestId("cost-total").textContent).toBe("n/a");
    expect(screen.getByText(/no model yet · 0 responses/)).toBeInTheDocument();
  });

  it("stays hidden in production, unless the URL says ?debug=1", async () => {
    vi.resetModules();
    vi.doMock("@/lib/public-env", () => ({
      publicEnv: { isDev: false, realtimeTransport: "webrtc" },
    }));
    const { CostOverlay: Prod } = await import("./cost-overlay");

    const { unmount } = render(<Prod cost={null} model={null} responses={0} />);
    expect(screen.queryByTestId("cost-overlay")).toBeNull();
    unmount();

    window.history.replaceState({}, "", "/?debug=1");
    render(<Prod cost={null} model={null} responses={0} />);
    expect(await screen.findByTestId("cost-overlay")).toBeInTheDocument();
  });
});
