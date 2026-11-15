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
    const form = screen.getByLabelText("Message").closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    rerender(<Composer onSend={onSend} disabled />);
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
