import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("three routes fit 360, 728 and 1280 without horizontal overflow", async ({ page }, testInfo) => {
  for (const width of [360, 728, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["contents", "assets", "templates"]) {
      await page.goto(`/${route}`);
      await expect(page.locator("nav.topnav")).toBeVisible();
      await expect(page.locator("nav.topnav .capsule-link")).toHaveCount(3);
      if (route === "contents") await expect(page.getByRole("heading", { name: "内容列表为空" })).toBeVisible();
      if (route === "assets") await expect(page.getByRole("heading", { name: "素材库为空" })).toBeVisible();
      if (route === "templates") await expect(page.getByRole("heading", { name: "模板库", exact: true })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await page.waitForTimeout(450);
      await page.screenshot({ path: testInfo.outputPath(`${route}-${width}.png`), fullPage: true });
    }
  }
});

test("new content opens Composer without creating a blank draft", async ({ page }) => {
  await page.goto("/contents");
  const legacyWrites: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/contents") legacyWrites.push(request.url());
  });
  await page.getByRole("button", { name: /新建内容/ }).first().click();
  await expect(page).toHaveURL(/\/compose$/);
  await expect(page.getByLabel("想法与要求")).toBeVisible();
  await expect(page.getByRole("radio", { name: /飞书文档/ })).toBeChecked();
  await page.getByRole("radio", { name: /HTML 演示/ }).check();
  await expect(page.getByRole("button", { name: "生成创作方案" })).toBeDisabled();
  expect(legacyWrites).toEqual([]);
});

test("settings drawer closes with Escape and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 728, height: 900 });
  await page.goto("/contents");
  const settings = page.getByRole("button", { name: "设置" });
  await settings.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("模型能力")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(settings).toBeFocused();
});


test("composer radio controls retain their size on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/compose");
  const radio = page.getByRole("radio", { name: /飞书文档/ });
  await expect(radio).toBeVisible();
  const size = await radio.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(size.width).toBeLessThanOrEqual(24);
  expect(size.height).toBeLessThanOrEqual(24);
  await page.getByRole("radio", { name: /HTML 演示/ }).check();
  await expect(page.getByRole("radio", { name: /HTML 演示/ })).toBeChecked();
});
