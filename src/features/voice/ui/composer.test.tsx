// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

describe("Composer", () => {
  it("sends on Enter and clears the field", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled={false} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(input).toHaveValue("");
  });

  it("ignores blank text and a disabled composer", () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} disabled={false} />);
    const form = screen
      .getByLabelText("Message")
      .closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    rerender(<Composer onSend={onSend} disabled />);
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("carries the mic toggle before the field and End after Send", () => {
    render(
      <Composer
        onSend={vi.fn()}
        disabled={false}
        leading={<button aria-label="Mute" />}
        trailing={<button aria-label="End" />}
      />,
    );
    const row = screen.getByTestId("composer-row");
    expect(
      [...row.children].map(
        (el) => el.getAttribute("aria-label") ?? el.getAttribute("data-testid"),
      ),
    ).toEqual(["Mute", "Message", "Send", "End"]);
  });

  it("offers Stop instead of Send while an answer is coming, until something is typed", () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer onSend={onSend} disabled={false} canStop onStop={onStop} />,
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop answer" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    // Stop is not the form's submit button: it must not send anything.
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "next" },
    });
    expect(screen.queryByRole("button", { name: "Stop answer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("keeps Send when there is nothing to stop", () => {
    render(
      <Composer
        onSend={vi.fn()}
        disabled={false}
        canStop={false}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
});
