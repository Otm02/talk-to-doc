// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import RouteError from "./error";
import GlobalError from "./global-error";
import NotFound from "./not-found";

afterEach(() => vi.unstubAllGlobals());

describe("not-found", () => {
  it("says so in plain words and links home", () => {
    render(<NotFound />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found." }),
    ).toBeInTheDocument();
    const home = screen.getByRole("link", { name: "Go home" });
    expect(home).toHaveAttribute("href", "/");
    // A tap target, not a text link.
    expect(home.className).toContain("h-12");
  });
});

describe("error (a crash below the layout)", () => {
  it("shows fixed copy, never the error, and Try again asks Next to retry", () => {
    const retry = vi.fn();
    render(
      <RouteError
        error={new Error("secret internals: sk-live-123")}
        retry={retry}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong." }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-live-123");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("Reload reloads the page", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<RouteError error={new Error("x")} retry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("global-error (the layout itself crashed)", () => {
  it("brings its own document and the one way out, Reload", () => {
    const html = renderToStaticMarkup(<GlobalError />);
    expect(html).toMatch(/^<html lang="en">/);
    expect(html).toContain("<body>");
    expect(html).toContain("<h1");
    expect(html).toContain("Reload to try again.");
    expect(html).toContain("Reload</button>");
    expect(html).not.toContain("Try again</button>");
  });
});
