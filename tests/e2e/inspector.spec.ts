import { expect, test, type Page } from "@playwright/test";

const contentA = "11111111-1111-4111-8111-111111111111";
const contentB = "22222222-2222-4222-8222-222222222222";

const rows = [
  {
    id: contentA,
    title: "内容 A",
    status: "ready",
    version: 1,
    kinds: ["feishu_doc"],
    renditionCount: 2,
    createdAt: "2026-10-20T08:00:00.000Z",
    updatedAt: "2026-10-21T09:30:00.000Z",
  },
  {
    id: contentB,
    title: "内容 B",
    status: "draft",
    version: 0,
    kinds: ["html_deck"],
    renditionCount: 1,
    createdAt: "2026-10-19T08:00:00.000Z",
    updatedAt: "2026-10-20T09:30:00.000Z",
  },
];

async function fulfillContents(page: Page) {
  await page.route(/\/api\/v1\/contents\?limit=100$/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { items: rows, nextCursor: null, total: rows.length },
        requestId: "inspector-e2e",
      }),
    });
  });
}

const inspector = (page: Page) => page.locator('aside[aria-label="内容检查器"]');

test("wide inspector remembers a collapsed preference across reloads", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fulfillContents(page);
  await page.goto("/contents");

  await expect(inspector(page)).toBeVisible();
  await expect(page.locator("#content-inspector")).toBeVisible();
  await expect(inspector(page).locator(".inspector-actions")).toBeInViewport();
  await expect(inspector(page).getByRole("heading", { name: "内容 A", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "查看 内容 B 详情" }).click();
  await expect(inspector(page).getByRole("heading", { name: "内容 B", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "收起详情" }).click();
  await expect(inspector(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看 内容 B 详情" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("dcw.inspector.contents"))).toBe("collapsed");

  await page.reload();
  await expect(page.getByRole("button", { name: "展开详情" })).toBeVisible();
  await expect(inspector(page)).toHaveCount(0);

  await page.getByRole("button", { name: "展开详情" }).click();
  await expect(inspector(page).getByRole("heading", { name: "内容 A", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("dcw.inspector.contents"))).toBe("expanded");
});

test("narrow screens open the inspector only on demand and restore focus", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await fulfillContents(page);
  await page.goto("/contents");

  await expect(page.getByRole("button", { name: "展开详情" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const card = page.getByRole("button", { name: "查看 内容 B 详情" });
  await card.click();
  const dialog = page.getByRole("dialog", { name: "内容详情" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "内容 B", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card).toBeFocused();

  await card.click();
  await expect(dialog).toBeVisible();
  await page.locator(".inspector-backdrop").click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);

  expect(await page.evaluate(() => localStorage.getItem("dcw.inspector.contents"))).toBeNull();

  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByRole("heading", { name: "内容 A", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("dcw.inspector.contents"))).toBeNull();
});

test("a narrow on-demand open never overwrites the saved wide preference", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fulfillContents(page);
  await page.goto("/contents");

  await page.getByRole("button", { name: "收起详情" }).click();
  expect(await page.evaluate(() => localStorage.getItem("dcw.inspector.contents"))).toBe("collapsed");

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "查看 内容 A 详情" }).click();
  await expect(page.getByRole("dialog", { name: "内容详情" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => localStorage.getItem("dcw.inspector.contents"))).toBe("collapsed");

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(inspector(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "展开详情" })).toBeVisible();
});

test("filtering away the selected record clears the stale inspector", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fulfillContents(page);
  await page.goto("/contents");

  await page.getByRole("button", { name: "查看 内容 B 详情" }).click();
  await expect(inspector(page).getByRole("heading", { name: "内容 B", exact: true })).toBeVisible();

  await page.getByLabel("搜索内容标题").fill("内容 A");
  await expect(inspector(page).getByRole("heading", { name: "内容 A", exact: true })).toBeVisible();
  await expect(inspector(page).getByRole("heading", { name: "内容 B", exact: true })).toHaveCount(0);

  await page.getByLabel("搜索内容标题").fill("没有这条记录");
  await expect(page.getByRole("heading", { name: "没有符合条件的内容" })).toBeVisible();
  await expect(inspector(page).getByText("没有可查看的内容")).toBeVisible();
  await expect(inspector(page).getByRole("heading", { name: "内容 B", exact: true })).toHaveCount(0);
});

test("content filters explain when only part of the library is loaded", async ({ page }) => {
  await page.route(/\/api\/v1\/contents\?limit=100$/u, (route) => route.fulfill({
    json: { data: { items: rows, total: 101, nextCursor: "2" }, requestId: "partial-content-library" },
  }));
  await page.goto("/contents");
  await expect(page.getByRole("status")).toContainText("当前显示最新的 2 份内容，共 101 份");
  await expect(page.getByRole("status")).toContainText("搜索与状态筛选仅作用于已显示的内容");
  await page.getByLabel("搜索内容标题").fill("未载入的内容");
  await expect(page.getByRole("status")).toBeVisible();
});
