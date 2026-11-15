// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentCard } from "@/features/document/document-card";
import type { DocumentData } from "./ingest-state";
import { ErrorCard } from "./error-card";
import { PdfPicker } from "./pdf-picker";
import { SourceSwitch } from "./source-switch";
import { PartialNotice, partialSummary } from "./partial-notice";
import { UploadStatus } from "./upload-status";
import { YoutubeField } from "./youtube-field";

afterEach(() => vi.unstubAllGlobals());

describe("SourceSwitch", () => {
  it("selects with click and arrow keys", async () => {
    const onChange = vi.fn();
    render(<SourceSwitch value="pdf" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "PDF" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "YouTube" }));
    expect(onChange).toHaveBeenLastCalledWith("youtube");
    screen.getByRole("radio", { name: "PDF" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("PdfPicker", () => {
  it("accepts PDFs only in the picker and passes the chosen file on", async () => {
    const onFile = vi.fn();
    render(<PdfPicker onFile={onFile} />);
    const input = screen.getByLabelText(/Choose a PDF/);
    expect(input).toHaveAttribute("accept", "application/pdf");
    const file = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    await userEvent.upload(input, file);
    expect(onFile).toHaveBeenCalledWith(file);
  });
});

describe("YoutubeField", () => {
  it("shows a live error for a bad link and blocks submit", async () => {
    const onSubmit = vi.fn();
    render(<YoutubeField onSubmit={onSubmit} />);
    await userEvent.type(
      screen.getByLabelText("YouTube link"),
      "https://example.com/watch",
    );
    expect(
      screen.getByText("That doesn't look like a YouTube video link."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load video" })).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a valid link with Enter", async () => {
    const onSubmit = vi.fn();
    render(<YoutubeField onSubmit={onSubmit} />);
    await userEvent.type(
      screen.getByLabelText("YouTube link"),
      "https://youtu.be/jNQXAC9IVRw{Enter}",
    );
    expect(onSubmit).toHaveBeenCalledWith("https://youtu.be/jNQXAC9IVRw");
  });

  it("hides Paste when the Clipboard API is missing", () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(<YoutubeField onSubmit={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /Paste/ }),
    ).not.toBeInTheDocument();
  });

  it("pastes from the clipboard when supported", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        readText: vi.fn().mockResolvedValue(" https://youtu.be/jNQXAC9IVRw "),
      },
    });
    render(<YoutubeField onSubmit={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Paste/ }));
    expect(screen.getByLabelText("YouTube link")).toHaveValue(
      "https://youtu.be/jNQXAC9IVRw",
    );
  });
});

describe("ErrorCard", () => {
  it("offers the right action per code", async () => {
    const onAction = vi.fn();
    const { rerender } = render(
      <ErrorCard code="pdf_too_large" onAction={onAction} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This PDF is over 25 MB.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Choose another file" }),
    );
    expect(onAction).toHaveBeenLastCalledWith("pick-another-file");

    rerender(<ErrorCard code="youtube_blocked" onAction={onAction} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Try a PDF instead" }),
    );
    expect(onAction).toHaveBeenLastCalledWith("try-pdf");

    rerender(<ErrorCard code="youtube_failed" onAction={onAction} />);
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("counts a 429 down on the button and re-enables it at 0", () => {
    vi.useFakeTimers();
    try {
      const onAction = vi.fn();
      render(
        <ErrorCard
          code="rate_limited"
          retryAt={Date.now() + 30_000}
          onAction={onAction}
        />,
      );
      const button = screen.getByTestId("retry-button");
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("Try again in 30s");
      // Said once with the error, not on every tick.
      expect(screen.getByRole("alert")).toHaveTextContent(
        "You can try again in 30 seconds.",
      );

      act(() => void vi.advanceTimersByTime(30_000));
      expect(button).toBeEnabled();
      expect(button).toHaveTextContent(/^Try again$/);
      fireEvent.click(button);
      expect(onAction).toHaveBeenCalledWith("retry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never makes 'choose another file' wait for a retry deadline", () => {
    render(
      <ErrorCard
        code="pdf_too_large"
        retryAt={Date.now() + 30_000}
        onAction={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Choose another file" }),
    ).toBeEnabled();
  });
});

describe("UploadStatus", () => {
  it("shows progress and cancels", async () => {
    const onCancel = vi.fn();
    render(
      <UploadStatus
        state={{
          status: "uploading",
          fileName: "a.pdf",
          size: 2048,
          percent: 42,
          stalled: false,
        }}
        source="pdf"
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("a.pdf")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("says which page is being read", () => {
    const doc: DocumentData = {
      meta: { documentId: "d", title: "T", sourceType: "pdf", pages: 120 },
      pages: Array.from({ length: 36 }, (_, i) => ({ page: i + 1, text: "x" })),
      segments: [],
      done: null,
    };
    render(
      <UploadStatus
        state={{ status: "extracting", doc }}
        source="pdf"
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading page 37 of 120…",
    );
  });
});

describe("DocumentCard: a load that stopped", () => {
  const doc = {
    meta: { documentId: "d", title: "T", sourceType: "pdf", pages: 120 },
    pages: [],
    segments: [],
    done: null,
  } as unknown as DocumentData;

  it("says Counting… while the load is going", () => {
    render(<DocumentCard doc={doc} />);
    expect(screen.getByText(/Counting…/)).toBeInTheDocument();
  });

  it("does not promise counts that will not come", () => {
    render(<DocumentCard doc={doc} interrupted />);
    expect(screen.queryByText(/Counting…/)).toBeNull();
    expect(screen.getByText("120 pages")).toBeInTheDocument();
  });
});

describe("DocumentCard", () => {
  const base: DocumentData = {
    meta: {
      documentId: "d",
      title: "Me at the zoo",
      sourceType: "youtube",
      videoId: "jNQXAC9IVRw",
      thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
      channel: "jawed",
      durationSec: 19,
      language: "en",
      isAutoGenerated: true,
      provider: "direct",
      cached: false,
    },
    pages: [],
    segments: [],
    done: null,
  };

  it("shows title and thumbnail as soon as meta arrives, before stats", () => {
    const { container } = render(<DocumentCard doc={base} />);
    expect(
      screen.getByRole("heading", { name: "Me at the zoo" }),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    );
    expect(screen.getByText(/Counting/)).toBeInTheDocument();
    expect(screen.getByText("Auto-generated captions")).toBeInTheDocument();
    expect(screen.queryByText(/Whole document/)).not.toBeInTheDocument();
  });

  it("shows stats and the whole-document coverage line", () => {
    render(
      <DocumentCard
        doc={{
          ...base,
          done: {
            done: true,
            stats: { segments: 1, words: 1200, tokens: 1600 },
            coverage: 1,
          },
        }}
      />,
    );
    expect(
      screen.getByText(/19 s · 1,200 words · 1,600 tokens/),
    ).toBeInTheDocument();
    expect(screen.getByText("Whole document in context")).toBeInTheDocument();
  });

  it("shows partial coverage and an info popover", async () => {
    render(
      <DocumentCard
        doc={{
          meta: {
            documentId: "d",
            title: "Big",
            sourceType: "pdf",
            pages: 120,
          },
          pages: [
            { page: 1, text: "" },
            { page: 2, text: "x" },
          ],
          segments: [],
          done: {
            done: true,
            stats: { pages: 120, words: 9, tokens: 9 },
            coverage: 0.649,
          },
        }}
      />,
    );
    expect(
      screen.getByText("First 64% fits in the voice context"),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 page had no text/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Why this matters" }),
    );
    expect(
      await screen.findByText(/limited amount of text/),
    ).toBeInTheDocument();
  });
});

describe("UploadStatus: a slow link", () => {
  const uploading = (percent: number, stalled: boolean) =>
    ({
      status: "uploading",
      fileName: "big.pdf",
      size: 20_000_000,
      percent,
      stalled,
    }) as const;

  it("says Connection is slow, keeps the real percent, and offers Cancel and Keep waiting", async () => {
    const onCancel = vi.fn();
    const onKeepWaiting = vi.fn();
    render(
      <UploadStatus
        state={uploading(37, true)}
        source="pdf"
        onCancel={onCancel}
        onKeepWaiting={onKeepWaiting}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Connection is slow");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "37",
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onKeepWaiting).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("offers only Cancel while the upload is moving", () => {
    render(
      <UploadStatus
        state={uploading(37, false)}
        source="pdf"
        onCancel={vi.fn()}
        onKeepWaiting={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    expect(screen.queryByRole("button", { name: "Keep waiting" })).toBeNull();
  });

  it("does not claim more than it knows at 100%", () => {
    render(
      <UploadStatus
        state={uploading(100, false)}
        source="pdf"
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Finishing upload…");
  });
});

describe("PartialNotice", () => {
  const pdf = {
    meta: {
      documentId: "d",
      title: "T",
      sourceType: "pdf",
      pages: 120,
    },
    pages: Array.from({ length: 37 }, (_, i) => ({ page: i + 1, text: "x" })),
    segments: [],
    done: null,
  } as unknown as DocumentData;

  it("says how much arrived, and offers Try again and Start over", async () => {
    const onRetry = vi.fn();
    const onStartOver = vi.fn();
    render(
      <PartialNotice doc={pdf} onRetry={onRetry} onStartOver={onStartOver} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The connection dropped. You have 37 of 120 pages.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await userEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });

  it("counts a video in time", () => {
    const video = {
      meta: {
        documentId: "d",
        title: "T",
        sourceType: "youtube",
        durationSec: 4320,
      },
      pages: [],
      segments: [{ startSec: 600, text: "x" }],
      done: null,
    } as unknown as DocumentData;
    expect(partialSummary(video)).toBe(
      "You have about the first 10 min of 1 h 12 min.",
    );
    expect(
      partialSummary({
        ...video,
        segments: [{ startSec: 0, text: "x" }],
      } as DocumentData),
    ).toBe("You have only the start of the captions.");
    expect(partialSummary({ ...video, segments: [] })).toBe(
      "None of the captions arrived.",
    );
  });
});
