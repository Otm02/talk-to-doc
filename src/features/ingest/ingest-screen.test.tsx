// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeNdjsonLine } from "@/lib/wire/ndjson";
import { IngestScreen } from "./ingest-screen";
import * as client from "./upload-client";

vi.mock("./upload-client", () => ({
  getUploadMode: vi.fn(),
  ingestPdf: vi.fn(),
  ingestYoutube: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

const pdfBytes = (head: number[]) =>
  new File([new Uint8Array(head)], "a.pdf", { type: "application/pdf" });
const PNG = [0x89, 0x50, 0x4e, 0x47];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

describe("IngestScreen", () => {
  it("drops an error when the user moves to the other tab", async () => {
    render(<IngestScreen />);
    await userEvent.upload(
      screen.getByLabelText(/Choose a PDF/),
      pdfBytes(PNG),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file isn't a PDF",
    );

    await userEvent.click(screen.getByRole("radio", { name: "YouTube" }));
    expect(screen.queryByRole("alert")).toBeNull();
    // The tab itself did switch, and nothing was sent.
    expect(screen.getByRole("radio", { name: "YouTube" })).toBeChecked();
    expect(client.ingestYoutube).not.toHaveBeenCalled();
  });

  it("keeps the error when the same tab is tapped again", async () => {
    render(<IngestScreen />);
    await userEvent.upload(
      screen.getByLabelText(/Choose a PDF/),
      pdfBytes(PNG),
    );
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("puts focus on the screen's heading after Use another source", async () => {
    vi.mocked(client.getUploadMode).mockResolvedValue("direct");
    vi.mocked(client.ingestPdf).mockImplementation(
      async () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            const lines = [
              { documentId: "d", title: "T", sourceType: "pdf", pages: 1 },
              { page: 1, text: "hello world" },
              {
                done: true,
                stats: { pages: 1, words: 2, tokens: 3 },
                coverage: 1,
              },
            ];
            c.enqueue(
              new TextEncoder().encode(lines.map(encodeNdjsonLine).join("")),
            );
            c.close();
          },
        }),
    );
    render(<IngestScreen />);
    await userEvent.upload(
      screen.getByLabelText(/Choose a PDF/),
      pdfBytes(PDF),
    );

    const another = await screen.findByRole("button", {
      name: "Use another source",
    });
    another.focus();
    await userEvent.click(another);

    const heading = await screen.findByRole("heading", {
      name: "Talk to a document",
    });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});
