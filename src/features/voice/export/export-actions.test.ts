// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, downloadMarkdown } from "./export-actions";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  // jsdom has no execCommand; tests add one and must not leak it.
  Reflect.deleteProperty(document, "execCommand");
});

function withExecCommand(result: boolean | Error) {
  const exec = vi.fn((command: string) => {
    void command;
    if (result instanceof Error) throw result;
    return result;
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: exec,
  });
  return exec;
}

describe("copyText", () => {
  it("uses the Clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => {});
    const exec = withExecCommand(true);
    await expect(
      copyText("# hello", { clipboard: { writeText }, document }),
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("# hello");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to a selection copy where the Clipboard API is missing", async () => {
    const exec = withExecCommand(true);
    let selected = "";
    exec.mockImplementation(() => {
      const field = document.querySelector("textarea");
      selected = field?.value ?? "";
      return true;
    });
    await expect(copyText("# hello", { document })).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(selected).toBe("# hello");
    // The helper field is gone afterwards.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when the Clipboard API refuses (permission, lost focus)", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const exec = withExecCommand(true);
    await expect(
      copyText("x", { clipboard: { writeText }, document }),
    ).resolves.toBe(true);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("reports failure, without throwing, when nothing works", async () => {
    // No clipboard and no execCommand at all.
    await expect(copyText("x", { document })).resolves.toBe(false);
    await expect(copyText("x", {})).resolves.toBe(false);

    // execCommand that says no, and one that throws.
    withExecCommand(false);
    await expect(copyText("x", { document })).resolves.toBe(false);
    withExecCommand(new Error("blocked"));
    await expect(copyText("x", { document })).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reads the real browser objects by default", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("from the page")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("from the page");
  });
});

describe("downloadMarkdown", () => {
  it("saves a Markdown file under the given name and cleans up after itself", async () => {
    vi.useFakeTimers();
    let blob: Blob | undefined;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return "blob:fake";
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    let name = "";
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        name = this.download;
      });

    expect(downloadMarkdown("report-2026-11-14.md", "# Report\n")).toBe(true);

    expect(click).toHaveBeenCalledOnce();
    expect(name).toBe("report-2026-11-14.md");
    expect(blob?.type).toBe("text/markdown;charset=utf-8");
    expect(await blob?.text()).toBe("# Report\n");
    expect(document.querySelector("a[download]")).toBeNull();
    // Not revoked at once: Safari can cancel the download if it is.
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });

  it("reports failure where files cannot be built", () => {
    Object.assign(URL, { createObjectURL: undefined });
    expect(downloadMarkdown("a.md", "x")).toBe(false);
    Object.assign(URL, {
      createObjectURL: () => {
        throw new Error("no blobs here");
      },
    });
    expect(downloadMarkdown("a.md", "x")).toBe(false);
  });
});
