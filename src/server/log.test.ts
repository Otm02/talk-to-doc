import { afterEach, describe, expect, it, vi } from "vitest";
import { logRequest, type RequestLog } from "./log";

afterEach(() => vi.restoreAllMocks());

describe("logRequest", () => {
  it("prints only the allowed fields, even if the entry carries more", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sneaky = {
      requestId: "r1",
      route: "ingest-pdf",
      status: 200,
      durationMs: 12,
      title: "Quarterly report",
      ip: "203.0.113.9",
      text: "document text",
    } satisfies RequestLog & Record<string, unknown>;

    logRequest(sneaky);

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      requestId: "r1",
      route: "ingest-pdf",
      status: 200,
      durationMs: 12,
    });
  });

  it("includes the error code only when there is one", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logRequest({
      requestId: "r3",
      route: "ingest-pdf",
      status: 200,
      durationMs: 9,
      code: "pdf_no_text",
    });
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      code: "pdf_no_text",
    });
  });

  it("includes the provider only when there is one", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logRequest({
      requestId: "r2",
      route: "ingest-youtube",
      status: 200,
      durationMs: 3,
      provider: "direct",
    });
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      provider: "direct",
    });
  });
});
