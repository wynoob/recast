import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("assets page stays honest, keyboard-safe and overflow-free at three widths", async ({ page }, testInfo) => {
  for (const width of [360, 728, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/assets");
    await expect(page.locator("nav.topnav .capsule-link")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "素材库为空" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`assets-${width}.png`), fullPage: true });
  }
});

test("import drawer scans only after input, traps focus and restores it on Escape", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/assets");
  const trigger = page.getByRole("button", { name: /导入素材/ }).first();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/只读扫描/)).toBeVisible();
  await expect(page.getByText(/总数未知，不显示假百分比/)).toHaveCount(0);
  const start = page.getByRole("button", { name: "开始扫描" });
  await expect(start).toBeDisabled();
  await page.getByLabel("本次要扫描的文件夹路径").fill("/tmp/t02b-not-scanned");
  await expect(start).toBeEnabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await expect(page.locator(".dialog-panel")).toHaveCSS("opacity", "1");
  await expect(page.locator(".dialog-backdrop")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("import-drawer-360.png"), fullPage: false, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("task drawer shows no invented historical jobs", async ({ page }) => {
  await page.setViewportSize({ width: 728, height: 900 });
  await page.goto("/assets");
  const trigger = page.getByRole("button", { name: "任务" });
  await trigger.click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "还没有任务记录" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});


test("missing position count comes from occurrences rather than asset total", async ({ page }) => {
  await page.route(/\/api\/v1\/assets\?/u, (route) => route.fulfill({
    json: { data: { items: [], total: 0, nextCursor: null, groupCounts: { mp4: 0, gif: 0, image: 0, markdownSources: 1, documentSources: 1, missingOccurrences: 5 } }, requestId: "missing-occurrence-count" },
  }));
  await page.goto("/assets");
  await expect(page.getByText("0 个素材 · 1 份来源文档 · 5 个缺失位置", { exact: true })).toBeVisible();
});
