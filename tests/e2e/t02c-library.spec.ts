import { expect, test, type Route } from "@playwright/test";
import { SourceContextSchema, SourceListSchema } from "@dmall/contracts";

test.describe.configure({ mode: "serial" });

const sourceId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const secondSourceId = "33333333-3333-4333-8333-333333333333";
const secondVersionId = "44444444-4444-4444-8444-444444444444";

const occurrence = {
  id: "55555555-5555-4555-8555-555555555555",
  sourceId,
  sourceVersionId: versionId,
  sourceTitle: "真实来源 A",
  sourceRelativePath: "docs/a.md",
  locator: {
    schemaVersion: 1 as const,
    kind: "markdown" as const,
    line: 4,
    column: 1,
    ordinal: 0,
    rawTarget: "public/assets/a.png",
    normalizedRelativePath: "public/assets/a.png",
    resolution: "inside_root" as const,
  },
  headingPath: "第一章",
  beforeText: "前文",
  afterText: "后文",
  mediaStatus: "available" as const,
  errorCode: null,
};

function sourceRow(id: string, version: string | null, title: string) {
  return {
    id,
    kind: "local_markdown",
    title,
    status: "active" as const,
    currentVersionId: version,
    occurrenceCount: version === null ? 0 : 1,
    missingOccurrenceCount: 0,
    linkedAssetCount: version === null ? 0 : 1,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

async function fulfillSources(route: Route, rows: unknown[]) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: SourceListSchema.parse({ items: rows, nextCursor: null, total: rows.length }),
      requestId: "t02c-e2e",
    }),
  });
}

test("source filter renders real rows and opens sourceId plus currentVersionId", async ({ page }) => {
  const detailRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/assets\/[0-9a-f-]{36}$/u.test(new URL(request.url()).pathname)) {
      detailRequests.push(request.url());
    }
  });
  await page.route(/\/api\/v1\/sources\?/u, (route) =>
    fulfillSources(route, [
      sourceRow(sourceId, versionId, "真实来源 A"),
      sourceRow(secondSourceId, secondVersionId, "真实来源 B"),
    ]),
  );
  await page.route(new RegExp(`/api/v1/sources/${sourceId}`, "u"), async (route) => {
    const data = SourceContextSchema.parse({
      source: {
        id: sourceId,
        kind: "local_markdown",
        title: "真实来源 A",
        canonicalKey: "docs/a.md",
        originalUri: null,
        status: "active",
      },
      version: {
        id: versionId,
        sourceId,
        fingerprint: "a".repeat(64),
        snapshotBlobHash: "b".repeat(64),
        capturedAt: "2026-10-21T00:00:00.000Z",
        fileUrl: `/api/v1/files/${"b".repeat(64)}`,
      },
      document: null,
      occurrences: [occurrence],
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data, requestId: "t02c-e2e" }),
    });
  });

  await page.goto("/assets");
  await page.getByRole("button", { name: "来源文档", exact: true }).click();
  await expect(page.locator(".source-row")).toHaveCount(2);
  await expect(page.locator(".source-row").first()).toContainText("本地 Markdown");
  expect(detailRequests).toHaveLength(0);
  await page.locator(".source-row").first().click();
  await expect(page.getByRole("dialog", { name: "来源文档上下文" })).toHaveCount(0);
  await page.getByRole("button", { name: "打开来源上下文", exact: true }).click();
  const overlay = page.getByRole("dialog", { name: "来源文档上下文" });
  await expect(overlay).toContainText("真实来源 A");
  await expect(overlay).toContainText("第一章");
  await overlay.getByRole("button", { name: "关闭来源上下文" }).click();
});

test("source filter shows an empty state", async ({ page }) => {
  await page.route(/\/api\/v1\/sources\?/u, (route) => fulfillSources(route, []));
  await page.goto("/assets");
  await page.getByRole("button", { name: "来源文档", exact: true }).click();
  await expect(page.getByRole("heading", { name: "还没有来源文档" })).toBeVisible();
});

test("source filter shows a retryable error", async ({ page }) => {
  let attempts = 0;
  await page.route(/\/api\/v1\/sources\?/u, async (route) => {
    attempts += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "来源读取失败", retryable: true, details: {} },
        requestId: "t02c-e2e",
      }),
    });
  });
  await page.goto("/assets");
  await page.getByRole("button", { name: "来源文档", exact: true }).click();
  await expect(page.getByText("来源文档暂时无法读取")).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
});

test("a source without currentVersionId makes no source request", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.route(/\/api\/v1\/sources\?/u, (route) =>
    fulfillSources(route, [sourceRow(sourceId, null, "旧来源")]),
  );
  await page.goto("/assets");
  await page.getByRole("button", { name: "来源文档", exact: true }).click();
  await page.locator(".source-row").click();
  await expect(page.getByText("该来源没有可打开的版本")).toBeVisible();
  await page.waitForTimeout(250);
  expect(requests.filter((path) => path === `/api/v1/sources/${sourceId}`)).toHaveLength(0);
});
