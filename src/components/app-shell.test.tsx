// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell", () => {
  it("renders the app name in the header and the page in main", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    expect(screen.getByRole("banner")).toHaveTextContent("Talk to a Doc");
    expect(screen.getByRole("main")).toHaveTextContent("page body");
  });
});
