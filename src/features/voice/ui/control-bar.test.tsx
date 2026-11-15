// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ControlBar } from "./control-bar";

function setup(over: Partial<React.ComponentProps<typeof ControlBar>> = {}) {
  const props = {
    muted: false,
    canMute: true,
    speaking: false,
    onToggleMute: vi.fn(),
    onStopAnswer: vi.fn(),
    onOpenKeyboard: vi.fn(),
    onEnd: vi.fn(),
    ...over,
  };
  render(<ControlBar {...props} />);
  return props;
}

describe("ControlBar", () => {
  it("shows Stop answer only while the assistant is speaking", () => {
    setup();
    expect(screen.queryByRole("button", { name: /stop answer/i })).toBeNull();
  });

  it("stops the answer", () => {
    const p = setup({ speaking: true });
    fireEvent.click(screen.getByRole("button", { name: /stop answer/i }));
    expect(p.onStopAnswer).toHaveBeenCalledTimes(1);
  });

  it("toggles mute and says which way", () => {
    const p = setup({ muted: true });
    const btn = screen.getByRole("button", { name: "Unmute" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(p.onToggleMute).toHaveBeenCalled();
  });

  it("disables Mute without a live mic, and opens the keyboard on tap", () => {
    const p = setup({ canMute: false });
    expect(screen.getByRole("button", { name: "Mute" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard" }));
    expect(p.onOpenKeyboard).toHaveBeenCalledTimes(1);
  });

  it("asks before ending", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    expect(p.onEnd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep talking" }));
    expect(p.onEnd).not.toHaveBeenCalled();
  });

  it("ends once confirmed", async () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    fireEvent.click(await screen.findByRole("button", { name: "End chat" }));
    expect(p.onEnd).toHaveBeenCalledTimes(1);
  });
});
