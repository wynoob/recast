import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("creates, edits, validates and reopens template versions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "模板库还没有内容" })).toBeVisible();
  await page.getByRole("button", { name: "建立第一份模板草稿" }).click();
  const name = `阶段复盘演示 ${Date.now()}`;
  await page.getByLabel("模板名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "HTML 演示" }).click();
  await page.locator(".narrative-choice").filter({ hasText: "阶段成果复盘" }).click();
  await page.getByRole("button", { name: "建立草稿" }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator(".state-pill.draft")).toContainText("草稿 · 未验证");
  await expect(page.locator(".deck-mini")).toHaveCount(9);

  const firstTitle = page.locator(".structure-edit-card input").first();
  await firstTitle.fill("阶段复盘 2026 年 10 月");
  await page.getByLabel("版本说明").fill("改封面标题并建立新版本");
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await expect(page).toHaveURL(/versionId=/);
  await expect(page.locator(".state-pill.draft")).toContainText("草稿 · 未验证");

  await page.getByRole("button", { name: "启动验证" }).click();
  await expect(page.getByText("验证进行中…", { exact: true })).toBeVisible();
  await expect(page.locator(".state-pill.ready")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("验证通过", { exact: true })).toBeVisible();
  await expect(page.locator(".validation-issue")).toHaveCount(0);
  const validationText = page.locator(".validation-check small").first();
  await expect(validationText).toBeVisible();
  expect(await validationText.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);

  const versionSelect = page.locator(".version-select select");
  const options = await versionSelect.locator("option").allTextContents();
  expect(options.some((item) => item.includes("v1") && item.includes("草稿"))).toBe(true);
  expect(options.some((item) => item.includes("v2") && item.includes("已就绪"))).toBe(true);
  const firstIndex = options.findIndex((item) => item.includes("v1") && item.includes("草稿"));
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  await versionSelect.selectOption({ index: firstIndex });
  await expect(page.locator(".state-pill.draft")).toContainText("草稿 · 未验证");
  await expect(page.locator(".validation-decision.pass")).toHaveCount(0);

  for (const width of [360, 728, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(120);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `${width}px detail overflow`).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`template-detail-${width}.png`), fullPage: true });
  }
});

test("create template dialog traps focus and closes with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 728, height: 900 });
  await page.goto("/templates");
  const opener = page.getByRole("button", { name: "建立模板草稿" });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("模板名称", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
