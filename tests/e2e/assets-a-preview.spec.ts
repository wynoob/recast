import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { ApiErrorSchema, ApiSuccessSchema, AssetPatchResultSchema, SourceContextSchema } from "@dmall/contracts";
import { afterText, beforeText, materialUsage, test } from "./fixtures/assets-a-app.js";

// This spec owns its server and DCW_DATA_ROOT, including when run beside empty-library specs.
// Build first; run only this file. Generated media, screenshots and logs stay in agent-evidence.
test.setTimeout(90_000);

const viewer = (page: Page) => page.getByRole("dialog", { name: "素材预览", exact: true });
const card = (page: Page, id: string) => page.locator(`button.asset-card[data-asset-id="${id}"]`);

async function screenshot(page: Page, testInfo: TestInfo, runRoot: string, name: string) {
  const directory = join(runRoot, "screenshots");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: await page.getByRole("dialog").count() === 0, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function expectContained(page: Page, target: Locator, checkVertical = true) {
  if (checkVertical) await target.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const viewport = page.viewportSize();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (box === null || viewport === null) throw new Error("预览没有可见布局");
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  if (checkVertical) {
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
}

async function expectOriginal(image: Locator, expectedWidth: number, expectedHash: string) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth)).toBe(expectedWidth);
  const src = await image.getAttribute("src");
  expect(src).not.toBeNull();
  expect(src?.split("?")[0]).toBe(`/api/v1/files/${expectedHash}`);
}

test.afterEach(async ({ page, assetsApp }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
    await screenshot(page, testInfo, assetsApp.runRoot, `failure-${testInfo.testId.replace(/[^a-zA-Z0-9-]/gu, "-")}`);
  }
});

for (const width of [1440, 768, 390]) {
  test(`real assets at ${width}: grid, original, zoom, sources, GIF/video and return`, async ({ page, assetsApp }, testInfo) => {
    const { image, gif, video } = assetsApp.assets;
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/assets");
    await expect(page.locator("button.asset-card")).toHaveCount(3);
    for (const asset of [image, gif, video]) {
      await expect(card(page, asset.id)).toBeVisible();
      const thumbnail = card(page, asset.id).locator("img");
      await expect(thumbnail).toBeVisible();
      await thumbnail.scrollIntoViewIfNeeded();
      await expect.poll(() => thumbnail.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
    }
    await expectContained(page, card(page, image.id), false);
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-populated-grid`);

    const imageCard = card(page, image.id);
    await imageCard.click();
    const dialog = viewer(page);
    await expect(dialog).toHaveClass(/asset-viewer/u);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    const original = dialog.getByTestId("asset-image");
    await expectOriginal(original, 1920, assetsApp.media.image.sha256);
    await expectContained(page, original);
    const detail = await assetsApp.detail(image.id);
    expect(detail.summary).toMatchObject({ width: 1920, height: 1200 });
    expect(detail.sourceSuggestion?.usageText).toBe(materialUsage);
    const originalResponse = await assetsApp.api.get(`/api/v1/files/${assetsApp.media.image.sha256}`);
    expect(originalResponse.ok()).toBe(true);
    expect(createHash("sha256").update(await originalResponse.body()).digest("hex")).toBe(assetsApp.media.image.sha256);
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-image-fit`);

    await dialog.getByRole("button", { name: "100%", exact: true }).click();
    await expect.poll(() => original.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(1920, 0);
    const scrolled = await original.evaluate((element) => {
      for (let parent = element.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
        if (parent.scrollWidth > parent.clientWidth && /auto|scroll/u.test(getComputedStyle(parent).overflowX)) {
          parent.scrollLeft = parent.scrollWidth - parent.clientWidth;
          return parent.scrollLeft > 0;
        }
      }
      return false;
    });
    expect(scrolled, "100% 原图须在预览区域内可横向滚动").toBe(true);
    await expectContained(page, dialog);
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-image-100-percent`);
    await dialog.getByRole("button", { name: "适应窗口", exact: true }).click();
    await expectContained(page, original);

    await dialog.getByRole("tab", { name: "概览", exact: true }).click();
    await expect(dialog.getByRole("tabpanel", { name: "概览", exact: true }).getByText(materialUsage, { exact: true })).toBeVisible();
    const fitArea = await original.boundingBox();
    await dialog.getByRole("button", { name: "专注预览", exact: true }).click();
    await expect(dialog.getByRole("tab", { name: "概览", exact: true })).toBeHidden();
    await expectOriginal(original, 1920, assetsApp.media.image.sha256);
    await expectContained(page, original);
    if (width === 1440 && fitArea !== null) {
      const focusArea = await original.boundingBox();
      expect(focusArea?.width).toBeGreaterThan(fitArea.width);
      expect(focusArea?.height).toBeGreaterThan(fitArea.height);
    }
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-focus-preview`);
    await dialog.getByRole("button", { name: "显示信息", exact: true }).click();
    await expect(dialog.getByRole("tab", { name: "概览", exact: true })).toBeVisible();

    await dialog.getByRole("tab", { name: "来源", exact: true }).click();
    const occurrence = detail.occurrences.find((item) => item.locator.kind === "markdown");
    if (occurrence === undefined) throw new Error("原图未关联真实 Markdown 出现位置");
    expect(occurrence.beforeText).toContain(beforeText);
    expect(occurrence.afterText).toContain(afterText);
    const sourceResponse = await assetsApp.api.get(`/api/v1/sources/${occurrence.sourceId}?versionId=${occurrence.sourceVersionId}`);
    expect(sourceResponse.ok()).toBe(true);
    const source = ApiSuccessSchema(SourceContextSchema).parse(await sourceResponse.json()).data;
    await dialog.getByRole("button", { name: "查看文档片段", exact: true }).click();
    expect(source.version.id).toBe(occurrence.sourceVersionId);
    expect(source.occurrences.some((item) => item.beforeText.includes(beforeText) && item.afterText.includes(afterText))).toBe(true);
    await expect(dialog.getByText(beforeText, { exact: false }).first()).toBeVisible();
    await expect(dialog.getByText(afterText, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.locator(".source-overlay")).toHaveCount(0);
    await expectContained(page, dialog);
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-real-source-fragment`);
    await dialog.getByRole("button", { name: "返回素材预览", exact: true }).click();
    await expectOriginal(dialog.getByTestId("asset-image"), 1920, assetsApp.media.image.sha256);
    await expect(dialog.getByRole("tab", { name: "来源", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(imageCard).toBeFocused();

    await imageCard.click();
    await dialog.getByRole("button", { name: `预览${gif.title}`, exact: true }).click();
    const animation = dialog.getByTestId("asset-gif");
    await expectOriginal(animation, 320, assetsApp.media.gif.sha256);
    const gifResponse = await assetsApp.api.get(`/api/v1/files/${assetsApp.media.gif.sha256}`);
    expect(gifResponse.headers()["content-type"]).toContain("image/gif");
    const gifBytes = await gifResponse.body();
    expect(gifBytes.subarray(0, 6).toString()).toMatch(/^GIF8[79]a$/u);
    expect(createHash("sha256").update(gifBytes).digest("hex")).toBe(assetsApp.media.gif.sha256);
    expect(assetsApp.media.gif.frames).toBeGreaterThan(1);
    await expectContained(page, animation);
    await dialog.getByRole("tab", { name: "来源", exact: true }).click();
    await dialog.getByText("完整路径", { exact: true }).click();
    await expect(dialog.getByText("media/shelf-animation.gif", { exact: false }).first()).toBeVisible();
    // GIF is only a local_file occurrence; a document-fragment action would invent context.
    expect((await assetsApp.detail(gif.id)).occurrences.every((item) => item.locator.kind === "local_file")).toBe(true);
    await expect(dialog.getByRole("button", { name: "查看文档片段", exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/该位置[前后]没有可展示的文字/u)).toHaveCount(0);
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-original-gif-local-source`);

    await dialog.getByRole("button", { name: `预览${video.title}`, exact: true }).click();
    const player = dialog.getByTestId("asset-video");
    await expect(player).toBeVisible();
    await expect.poll(() => player.evaluate((element) => element instanceof HTMLVideoElement && element.readyState >= 1 && Number.isFinite(element.duration) && element.duration > 5 && element.videoWidth === 320)).toBe(true);
    expect(await player.getAttribute("src")).toBe(`/api/v1/files/${assetsApp.media.video.sha256}`);
    await player.evaluate(async (element) => {
      if (!(element instanceof HTMLVideoElement)) throw new Error("预览必须使用真实 video 元素");
      element.muted = true;
      await new Promise<void>((resolve, reject) => {
        element.addEventListener("playing", () => resolve(), { once: true });
        element.play().catch(reject);
      });
    });
    await expect.poll(() => player.evaluate((element) => element instanceof HTMLVideoElement && !element.paused && element.currentTime > 0.2)).toBe(true);
    await player.evaluate(async (element) => {
      if (!(element instanceof HTMLVideoElement)) throw new Error("预览必须使用真实 video 元素");
      element.pause();
      await new Promise<void>((resolve) => {
        element.addEventListener("seeked", () => resolve(), { once: true });
        element.currentTime = 3;
      });
    });
    await expect.poll(() => player.evaluate((element) => element instanceof HTMLVideoElement ? element.currentTime : -1)).toBeCloseTo(3, 1);
    expect(await player.evaluate((element) => element instanceof HTMLVideoElement && element.readyState >= 2 && element.error === null)).toBe(true);
    const range = await assetsApp.api.get(`/api/v1/files/${assetsApp.media.video.sha256}`, { headers: { Range: "bytes=0-63" } });
    expect(range.status()).toBe(206);
    expect(range.headers()["content-range"]).toMatch(/^bytes 0-63\//u);
    expect((await range.body()).byteLength).toBe(64);
    await player.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await expect(player).toBeVisible();
    await expect(dialog.getByTestId("asset-image")).toHaveCount(0);
    await expect(dialog.getByTestId("asset-gif")).toHaveCount(0);
    await expectContained(page, player);
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-video-playing-seeked`);
    await dialog.getByRole("button", { name: /返回素材库$/u }).click();
    await expect(dialog).toHaveCount(0);
    await expect(imageCard).toBeFocused();
    await expect(page.locator("button.asset-card")).toHaveCount(3);
    await screenshot(page, testInfo, assetsApp.runRoot, `${width}-returned-grid`);
  });
}

test("keyboard and buttons follow the current grid order and Escape restores the opening card", async ({ page, assetsApp }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/assets");
  const cards = page.locator("button.asset-card");
  await expect(cards).toHaveCount(3);
  const ids = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-asset-id")));
  const secondId = ids[1];
  const lastId = ids[2];
  if (secondId == null || lastId == null) throw new Error("网格缺少导航目标");
  const second = await assetsApp.detail(secondId);
  const last = await assetsApp.detail(lastId);
  const dialog = viewer(page);
  await cards.first().click();
  await dialog.getByRole("button", { name: "下一项", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: second.summary.title, exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("heading", { name: last.summary.title, exact: true })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("heading", { name: second.summary.title, exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "上一项", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "上一项", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cards.first()).toBeFocused();
});

test("UI edits persist on reopen; real competing writes cause conflicts without overwriting", async ({ page, assetsApp }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = assetsApp.assets.image.id;
  await page.goto("/assets");
  await card(page, id).click();
  const dialog = viewer(page);
  await dialog.getByRole("tab", { name: "概览", exact: true }).click();
  await dialog.getByRole("button", { name: "编辑标题与标签", exact: true }).click();
  const title = dialog.getByLabel(/^标题/u);
  const tags = dialog.getByLabel(/^标签/u);
  const savedTitle = "货架盘点原图 · 已保存";
  await title.fill(savedTitle);
  await title.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect(title).toHaveValue(savedTitle);
  await expect(dialog.getByTestId("asset-image")).toBeVisible();
  await tags.fill("盘点, 培训");
  const patchResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/assets/${id}`);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  const savedResponse = await patchResponse;
  expect(savedResponse.status()).toBe(200);
  const saved = ApiSuccessSchema(AssetPatchResultSchema).parse(await savedResponse.json()).data;
  expect(saved).toMatchObject({ title: savedTitle, tags: ["盘点", "培训"], origins: { title: "manual", tags: "manual" } });
  expect((await assetsApp.detail(id)).humanFields).toMatchObject({ title: savedTitle, tags: ["盘点", "培训"] });
  await expect(dialog.getByRole("status")).toContainText("已保存");
  await dialog.getByRole("button", { name: /返回素材库$/u }).click();
  await page.reload();
  await expect(card(page, id)).toContainText(savedTitle);
  await card(page, id).click();
  await dialog.getByRole("button", { name: "编辑标题与标签", exact: true }).click();
  await expect(title).toHaveValue(savedTitle);
  await expect(tags).toHaveValue("盘点, 培训");

  const mine = "本地编辑草稿不能丢失";
  await title.fill(mine);
  const externalTitle = "另一处真实写入";
  const competing = await assetsApp.patch(id, { schemaVersion: 1, expectedVersion: saved.version, title: externalTitle, tags: ["外部修改"] });
  const conflictResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/assets/${id}`);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  const conflictHttp = await conflictResponse;
  expect(conflictHttp.status()).toBe(409);
  expect(ApiErrorSchema.parse(await conflictHttp.json()).error.code).toBe("ASSET_VERSION_CONFLICT");
  await expect(dialog.getByRole("alert")).toContainText(externalTitle);
  await expect(title).toHaveValue(mine);
  expect((await assetsApp.detail(id)).summary).toMatchObject({ title: externalTitle, version: competing.version });
  await expect(dialog.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
  await screenshot(page, testInfo, assetsApp.runRoot, "edit-real-api-conflict");
  await dialog.getByRole("button", { name: "保留我的输入", exact: true }).click();
  await expect(title).toHaveValue(mine);
  // Choosing this action must not itself write. Only the explicit save may advance the version.
  expect((await assetsApp.detail(id)).summary.version).toBe(competing.version);
  const retryResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/assets/${id}`);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect(dialog.getByRole("status")).toContainText("已保存");
  const resolved = await assetsApp.detail(id);
  expect(resolved.summary).toMatchObject({ title: mine, version: competing.version + 1 });
  await dialog.getByRole("button", { name: /返回素材库$/u }).click();
  await page.reload();
  await card(page, id).click();
  await dialog.getByRole("button", { name: "编辑标题与标签", exact: true }).click();
  await expect(title).toHaveValue(mine);
  await expect(tags).toHaveValue("盘点, 培训");

  await title.fill("载入最新前的草稿");
  const latest = await assetsApp.patch(id, { schemaVersion: 1, expectedVersion: resolved.summary.version, title: "服务端最新标题", tags: ["最新标签"] });
  const secondConflict = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/v1/assets/${id}`);
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  expect((await secondConflict).status()).toBe(409);
  await dialog.getByRole("button", { name: "载入最新版本", exact: true }).click();
  await expect(title).toHaveValue(latest.title);
  await expect(tags).toHaveValue("最新标签");
  await expect(dialog.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
  expect((await assetsApp.detail(id)).summary.version).toBe(latest.version);
  await screenshot(page, testInfo, assetsApp.runRoot, "edit-adopted-latest-version");
  await dialog.getByRole("button", { name: /返回素材库$/u }).click();
  await expect(card(page, id)).toBeFocused();
});

test("unsaved edits cannot escape through the sidebar and discarding a collapsed editor resets its draft", async ({ page, assetsApp }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = assetsApp.assets.image.id;
  const baseline = await assetsApp.detail(id);
  await page.goto("/assets");
  await card(page, id).click();
  const dialog = viewer(page);
  await expect(page.locator(".asset-shell")).toHaveAttribute("inert", "");
  await page.locator('nav.topnav a[href="/templates"]').click({ force: true });
  await expect(page).toHaveURL(/\/assets$/u);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "编辑标题与标签", exact: true }).click();
  const title = dialog.getByLabel(/^标题/u);
  await title.fill("应放弃的草稿");
  await dialog.getByRole("button", { name: "收起编辑", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("未保存");
  await dialog.getByRole("button", { name: "放弃未保存修改", exact: true }).click();
  await expect(title).toHaveCount(0);
  await dialog.getByRole("button", { name: "编辑标题与标签", exact: true }).click();
  await expect(title).toHaveValue(baseline.humanFields.title);
  await title.fill("新的草稿仍须保护");
  await dialog.getByRole("button", { name: /返回素材库$/u }).click();
  await expect(dialog.getByRole("alert")).toContainText("未保存");
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(title).toHaveValue("新的草稿仍须保护");
  await dialog.getByRole("button", { name: /返回素材库$/u }).click();
  await dialog.getByRole("button", { name: "放弃未保存修改", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(page, id)).toBeFocused();
  await expect(page.locator(".asset-shell")).not.toHaveAttribute("inert", "");
  expect((await assetsApp.detail(id)).humanFields.title).toBe(baseline.humanFields.title);
});
