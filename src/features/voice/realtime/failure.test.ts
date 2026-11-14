import { describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "@/lib/errors/catalog";
import {
  endReasonMessage,
  failureMessage,
  isBillingCode,
  isFailureCode,
  micFailureCode,
  type MicFailure,
} from "./failure";

describe("failureMessage", () => {
  it("uses the SPEC copy for client-side codes", () => {
    expect(failureMessage("mic_denied")).toBe(
      "Microphone access is off. You can type instead, or allow the mic in your browser settings.",
    );
    expect(failureMessage("mic_not_found")).toBe(
      "No microphone found. You can type your questions instead.",
    );
    expect(failureMessage("mic_in_use")).toBe(
      "Your microphone is busy in another app. Close it and try again, or type instead.",
    );
    expect(failureMessage("session_reconnect_failed")).toBe(
      "Connection lost. Check your network and try again.",
    );
  });

  it("uses the shared catalog copy for server codes, never an upstream message", () => {
    expect(failureMessage("budget_exhausted")).toBe(
      ERROR_CATALOG.budget_exhausted.message,
    );
    expect(failureMessage("session_upstream_busy")).toBe(
      ERROR_CATALOG.session_upstream_busy.message,
    );
  });

  it("recognises codes it has copy for", () => {
    expect(isFailureCode("mic_denied")).toBe(true);
    expect(isFailureCode("daily_limit")).toBe(true);
    expect(isFailureCode("totally_made_up")).toBe(false);
  });
});

describe("micFailureCode", () => {
  it.each<[MicFailure, string]>([
    ["denied", "mic_denied"],
    ["not_found", "mic_not_found"],
    ["in_use", "mic_in_use"],
    ["insecure", "mic_unavailable"],
    ["unsupported", "mic_unavailable"],
    ["unavailable", "mic_unavailable"],
  ])("maps %s to %s", (reason, code) => {
    expect(micFailureCode(reason)).toBe(code);
    expect(failureMessage(micFailureCode(reason)).length).toBeGreaterThan(10);
  });
});

describe("endReasonMessage", () => {
  it("is silent when the user ended it", () => {
    expect(endReasonMessage("user", 5)).toBeNull();
  });
  it("names the real cap, not a fixed ten minutes", () => {
    expect(endReasonMessage("max_duration", 5)).toBe(
      "This chat reached its 5-minute limit. Start a new one to keep going.",
    );
    expect(endReasonMessage("max_duration", 10)).toContain("10-minute");
  });
  it("explains idle and hidden endings", () => {
    expect(endReasonMessage("idle", 5)).toBe(
      "Chat ended after 2 minutes of silence. Start again when you're ready.",
    );
    expect(endReasonMessage("hidden", 5)).toBe(
      "Chat ended because the app was in the background.",
    );
  });
});

describe("isBillingCode", () => {
  it.each([
    "credit_balance_exhausted",
    "project_spend_limit_exceeded",
    "organization_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
  ])("flags %s", (code) => expect(isBillingCode(code)).toBe(true));

  it("does not flag ordinary errors or empty values", () => {
    expect(isBillingCode("rate_limit_exceeded")).toBe(false);
    expect(isBillingCode("invalid_value")).toBe(false);
    expect(isBillingCode(null)).toBe(false);
    expect(isBillingCode(undefined)).toBe(false);
  });
});
