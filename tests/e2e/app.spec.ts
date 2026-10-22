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
      if (route === "templates") await expect(page.getByRole("heading", { name: "让结构先站稳" })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await page.waitForTimeout(450);
      await page.screenshot({ path: testInfo.outputPath(`${route}-${width}.png`), fullPage: true });
    }
  }
});

test("creates a blank content and reopens it after reload", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/contents");
  await page.getByRole("button", { name: /新建内容/ }).first().click();
  const title = `浏览器验收 ${Date.now()}`;
  await page.getByLabel("内容标题").fill(title);
  await page.getByRole("button", { name: "建立空白内容" }).click();
  await expect(page).toHaveURL(/\/contents\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("完整编辑尚未开放")).toBeVisible();
  const edited = `${title} 已改`;
  await page.getByRole("textbox", { name: "内容标题" }).fill(edited);
  await page.getByRole("button", { name: "保存标题" }).click();
  await expect(page.getByText("标题已保存到本机。")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: edited })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath("content-detail-reopened.png"), fullPage: true });
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
