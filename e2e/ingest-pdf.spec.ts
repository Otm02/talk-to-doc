import path from "node:path";
import { expect, test } from "@playwright/test";

const fixture = (name: string) =>
  path.join(process.cwd(), "test/fixtures/pdf", name);

test.describe("PDF ingestion", () => {
  test("sample PDF reaches the ready state through the real route", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sample PDF" }).click();

    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(page.getByText("Whole document in context")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start voice chat" })).toBeDisabled();

    await page.getByRole("button", { name: "Show full text" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Page 1", { exact: true })).toBeVisible();
    await dialog.getByLabel("Search in text").fill("constitution");
    await expect(dialog.getByText(/of \d+/)).toBeVisible();
    await dialog.getByRole("button", { name: "Close full text" }).click();

    await page.getByRole("button", { name: "Use another source" }).click();
    await expect(page.getByRole("heading", { name: "Talk to a document" })).toBeVisible();
  });

  test("a chosen file is uploaded and read", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/Choose a PDF/).setInputFiles(fixture("multi-page.pdf"));
    await expect(page.getByRole("button", { name: "Show full text" })).toBeVisible();
    await expect(page.getByText(/\d+ pages? · [\d,]+ words/)).toBeVisible();
  });

  test("an oversize file is refused before any upload", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/");
    await page.getByLabel(/Choose a PDF/).setInputFiles({
      name: "big.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
    });
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("This PDF is over 25 MB. Try a smaller file.");
    await expect(page.getByRole("button", { name: "Choose another file" })).toBeVisible();
    expect(requests.filter((u) => u.includes("/api/ingest"))).toEqual([]);
  });

  test("a non-PDF is refused", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/Choose a PDF/).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("This file isn't a PDF.");
  });

  test("a scanned PDF shows the server's no-text error", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel(/Choose a PDF/).setInputFiles(fixture("image-only.pdf"));
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toContainText("no selectable text");
    await expect(page.getByRole("button", { name: "Choose another file" })).toBeVisible();
  });

  test("no horizontal overflow at 390 wide", async ({ page }) => {
    await page.goto("/");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
