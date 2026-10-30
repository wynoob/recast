import { expect, test } from "@playwright/test";
import {
  ApiSuccessSchema,
  ImportDetailSchema,
  JobSnapshotSchema,
  SettingsSchema,
} from "@dmall/contracts";

test.describe.configure({ mode: "serial" });

const importId = "66666666-6666-4666-8666-666666666666";
const jobId = "77777777-7777-4777-8777-777777777777";
const scanId = "88888888-8888-4888-8888-888888888888";
const mappingItemId = "99999999-9999-4999-8999-999999999999";
const mappingVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const at = "2026-10-21T00:00:00.000Z";
const forbidden = [
  "not_implemented_t02",
  "implemented_pending_acceptance",
  "available_t02",
  "最终验收",
  "评审队列",
  "后端接口缺项",
  "证据目录",
  "测试数量",
];

test("settings maps every localImport state to product actions", async ({ page, request }) => {
  const settingsResponse = ApiSuccessSchema(SettingsSchema).parse(
    await (await request.get("/api/v1/settings")).json(),
  );
  let localImport: "not_implemented_t02" | "implemented_pending_acceptance" | "available_t02" =
    "implemented_pending_acceptance";
  await page.route("**/api/v1/settings", async (route) => {
    const data = SettingsSchema.parse({
      ...settingsResponse.data,
      features: { ...settingsResponse.data.features, localImport },
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data, requestId: "t02c-e2e" }),
    });
  });

  for (const state of [
    "implemented_pending_acceptance",
    "available_t02",
    "not_implemented_t02",
  ] as const) {
    localImport = state;
    await page.goto("/assets");
    await page.getByRole("button", { name: "设置" }).click();
    const dialog = page.getByRole("dialog");
    const action = dialog.locator(".status-row", { hasText: "扫描文件夹与导入本地副本" });
    await expect(action).toBeVisible();
    if (state === "not_implemented_t02") {
      await expect(action.getByText("当前版本不支持本地导入", { exact: true })).toBeVisible();
    } else {
      await expect(action.getByText("可用", { exact: true })).toBeVisible();
    }
    await expect(dialog.getByText("编辑素材标题与标签")).toBeVisible();
    const templates = dialog.locator(".status-row", { hasText: "模板编辑与验证" });
    await expect(templates.getByText(settingsResponse.data.features.templates === "not_implemented_t05" ? "未开放" : "可用", { exact: true })).toBeVisible();
    const text = await dialog.innerText();
    for (const term of forbidden) expect(text).not.toContain(term);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});

test("partial mapping failure never uses full-success copy", async ({ page }) => {
  const job = JobSnapshotSchema.parse({
    schemaVersion: 1,
    id: jobId,
    type: "local_import",
    state: "partial",
    phase: "done",
    attempt: 1,
    maxAttempts: 3,
    leaseGeneration: 1,
    leaseUntil: null,
    cancelRequested: false,
    checkpoint: null,
    result: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  });
  const detail = ImportDetailSchema.parse({
    importId,
    jobId,
    scanId,
    status: "partial",
    phase: "done",
    counts: { pending: 0, committed: 2, failed: 0, skipped: 0, total: 2 },
    items: [
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        scanItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        relativePath: "image.png",
        state: "committed",
        attempt: 1,
        assetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sourceVersionId: null,
        occurrenceId: null,
        errorCode: null,
        errorMessage: null,
      },
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        scanItemId: mappingItemId,
        relativePath: "notes.md",
        state: "committed",
        attempt: 1,
        assetId: null,
        sourceVersionId: mappingVersionId,
        occurrenceId: null,
        errorCode: null,
        errorMessage: null,
      },
    ],
    nextCursor: null,
    result: null,
    mapping: {
      requestedSourceCount: 1,
      appliedSourceCount: 0,
      status: "failed",
      entryCount: 0,
      linkedEntryCount: 0,
      warningCount: 0,
      sources: [
        {
          sourceScanItemId: mappingItemId,
          relativePath: "notes.md",
          mapIndex: 0,
          status: "failed",
          sourceVersionId: mappingVersionId,
          entryCount: 0,
          linkedEntryCount: 0,
          warningCount: 0,
          errorCode: "MAPPING_FORMAT_NOT_FOUND",
        },
      ],
    },
    error: null,
  });

  await page.route(`**/api/v1/jobs/${jobId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: job, requestId: "t02c-e2e" }),
    }),
  );
  await page.route(`**/api/v1/imports/${importId}?*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: detail, requestId: "t02c-e2e" }),
    }),
  );

  await page.goto(`/assets?import=${importId}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("媒体已导入；说明文档未应用").first()).toBeVisible();
  await expect(dialog.getByText("未应用", { exact: true }).first()).toBeVisible();
  await expect(dialog.locator(".notice.success")).toHaveCount(0);
  await expect(dialog.getByText("已导入 2 项")).toHaveCount(0);
});
