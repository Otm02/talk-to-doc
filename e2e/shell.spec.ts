import { expect, test } from "@playwright/test";

test("shell loads at phone size without horizontal scroll", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("banner")).toContainText("Talk to a Doc");
  await expect(
    page.getByRole("heading", { name: "Talk to a document" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
});

test("sends security headers", async ({ request }) => {
  const res = await request.get("/");
  const headers = res.headers();
  expect(headers["permissions-policy"]).toContain("microphone=(self)");
  expect(headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
});

test("health reports the memory driver locally", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    model: "gpt-realtime-2.1-mini",
    uploadMode: "direct",
    state: "memory",
  });
});
