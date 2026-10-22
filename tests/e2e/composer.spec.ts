import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { CompositionView, Proposal } from "@dmall/contracts";

const contentId = randomUUID();
const exportId = randomUUID();
const revisionId = randomUUID();
const templateId = randomUUID();
const evidenceId = randomUUID();
const now = "2026-10-22T03:00:00.000Z";

function proposal(): Proposal {
  return {
    id: randomUUID(), contentId, basedOnVersion: 1, hash: "a".repeat(64),
    title: "面向店长的库存改进实施方案", purpose: "说明库存改进步骤", audience: "店长",
    delivery: { kind: "feishu_doc", folderToken: null },
    template: { versionId: templateId, packageHash: "b".repeat(64), reason: "按现状、行动、复盘组织，适合店长执行" },
    evidence: [{ id: evidenceId, kind: "media", title: "盘点现场图", sourceLabel: "甲商家巡店记录", merchantId: null, availability: "available" }],
    gaps: [],
    sections: [{ key: "action", heading: "店长操作步骤", intent: "按日执行", templateContainerKey: "body", placements: [{ evidenceId, purpose: "说明盘点操作", position: "操作步骤之后", use: "illustration" }] }],
  };
}

async function envelope(page: Page, pattern: string, data: unknown) {
  await page.route(pattern, (route) => route.fulfill({ json: { data, requestId: randomUUID() } }));
}

async function shell(page: Page) {
  const empty = { items: [], total: 0, nextCursor: null };
  await envelope(page, "**/api/v1/health", { schemaVersion: 1, status: "ok", appVersion: "test", node: "v24.22.0", platform: "darwin", arch: "arm64", csrfToken: "test-csrf", database: { status: "ok", journalMode: "wal", foreignKeys: true, busyTimeoutMs: 1000, migrationCount: 10 }, workers: { configured: 1, ready: 1 } });
  for (const resource of ["contents", "assets", "templates"]) await envelope(page, `**/api/v1/${resource}?*`, empty);
}

// These are frontend contract fixtures. Full provider, delivery and offline flows run after integration.
test.describe("Composer 前端契约夹具", () => {
  test.beforeEach(async ({ page }) => shell(page));

  test("提交失败后重试复用同一动作键，方案有真实契约字段且一次确认", async ({ page }) => {
    const plan = proposal();
    const proposed: CompositionView = { contentId, version: 1, progress: null, state: "proposed", proposal: plan };
    const keys: (string | undefined)[] = [];
    await page.route("**/api/v1/compositions/submit", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
      expect(route.request().postDataJSON()).toEqual({ mode: "create", idea: "给店长说明库存改进方案", delivery: { kind: "feishu_doc", folderToken: null } });
      if (keys.length === 1) return route.abort("failed");
      return route.fulfill({ json: { data: { state: "planning", contentId, version: 1, progress: null, step: "intent" }, requestId: randomUUID() } });
    });
    await envelope(page, `**/api/v1/compositions/${contentId}`, proposed);
    let confirmations = 0;
    await page.route("**/api/v1/compositions/confirm", async (route) => {
      confirmations++;
      expect(route.request().postDataJSON()).toEqual({ proposalId: plan.id, proposalHash: plan.hash });
      const working: CompositionView = { state: "working", contentId, version: 2, progress: null, confirmationId: randomUUID(), step: "writing" };
      await envelope(page, `**/api/v1/compositions/${contentId}`, working);
      return route.fulfill({ json: { data: working, requestId: randomUUID() } });
    });
    await page.goto("/compose");
    await page.getByLabel("想法与要求").fill("给店长说明库存改进方案");
    await page.getByRole("button", { name: "生成创作方案" }).click();
    await page.getByRole("button", { name: "重试同一请求" }).click();
    await expect(page).toHaveURL(new RegExp(`/contents/${contentId}$`));
    await expect(page.getByRole("heading", { name: plan.title })).toBeVisible();
    await expect(page.getByText(plan.template.reason)).toBeVisible();
    await expect(page.getByText("操作步骤之后 · 说明盘点操作")).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/);
    await page.getByRole("button", { name: "确认方案并生成成品" }).dblclick();
    await expect(page.getByRole("heading", { name: "写作全文" })).toBeVisible();
    expect(confirmations).toBe(1);
    await expect(page.locator("progress")).not.toHaveAttribute("value");
    await page.reload();
    await expect(page.getByRole("heading", { name: "写作全文" })).toBeVisible();
  });

  test("缺口阻断确认，补充和排除素材通过 adjust 提交当前版本", async ({ page }) => {
    const plan = proposal();
    plan.gaps = [{ key: "period", question: "盘点周期是什么？", blocksGeneration: true }];
    await envelope(page, `**/api/v1/compositions/${contentId}`, { contentId, version: 1, progress: null, state: "proposed", proposal: plan });
    let adjustment: unknown;
    await page.route("**/api/v1/compositions/submit", (route) => {
      adjustment = route.request().postDataJSON();
      return route.fulfill({ json: { data: { contentId, version: 2, progress: null, state: "planning", step: "recommend" }, requestId: randomUUID() } });
    });
    await page.goto(`/contents/${contentId}`);
    await expect(page.getByRole("button", { name: "确认方案并生成成品" })).toBeDisabled();
    await page.getByLabel(/盘点现场图/).uncheck();
    await page.getByLabel("补充或调整要求").fill("盘点周期为每周一次");
    await page.getByRole("button", { name: "按调整重新规划" }).click();
    await expect.poll(() => adjustment).toEqual({ mode: "adjust", contentId, expectedVersion: 1, instruction: "盘点周期为每周一次", choices: { selection: { includeHandles: [], excludeEvidenceIds: [evidenceId] } } });
    await page.reload();
    await expect(page.getByLabel(/盘点现场图/)).not.toBeChecked();
  });

  test("远端未知只提供核对原文档，恢复携带原输出、operation 和决策版本", async ({ page }) => {
    const operationId = randomUUID();
    await envelope(page, `**/api/v1/compositions/${contentId}`, { state: "blocked", contentId, version: 2, progress: null, step: "delivering", code: "REMOTE_RESULT_UNKNOWN", message: "飞书创建响应不明，请核对原文档", actions: [{ kind: "verify_remote", exportId, operationId, decisionVersion: 4 }], availableRevisionId: revisionId });
    let resumed: unknown;
    await page.route(`**/api/v1/compositions/${contentId}/resume-delivery`, (route) => {
      resumed = route.request().postDataJSON();
      return route.fulfill({ json: { data: { state: "working", contentId, version: 2, progress: null, confirmationId: randomUUID(), step: "delivering" }, requestId: randomUUID() } });
    });
    await page.goto(`/contents/${contentId}`);
    await expect(page.getByRole("button", { name: "恢复原交付" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "绑定原文档并继续" })).toBeDisabled();
    await page.getByLabel("原飞书文档 ID").fill("original-document");
    await page.getByLabel("我已核对，这是本次操作创建的原文档").check();
    await page.getByRole("button", { name: "绑定原文档并继续" }).click();
    await expect.poll(() => resumed).toEqual({ contentId, expectedExportId: exportId, expectedDecisionVersion: 4, decision: { kind: "bind_verified_document", operationId, documentId: "original-document", confirmedOriginal: true } });
  });

  test("HTML 结果只使用已交付的 iframe 和 ZIP，移动宽度没有溢出", async ({ page }) => {
    const previewUrl = `/api/v1/exports/${exportId}/preview/index.html`;
    const downloadUrl = `/api/v1/exports/${exportId}/artifacts/package.zip`;
    await envelope(page, `**/api/v1/compositions/${contentId}`, { contentId, version: 2, progress: null, state: "delivered", result: { kind: "html_deck", exportId, revisionId, previewUrl, zip: { id: randomUUID(), kind: "html_zip", fileName: "deck.zip", mime: "application/zip", bytes: 100, sha256: "c".repeat(64), downloadUrl, createdAt: now } } });
    await page.route(`**${previewUrl}`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: "<html><body><h1>契约夹具预览</h1></body></html>" }));
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/contents/${contentId}`);
      await expect(page.getByRole("link", { name: "下载 ZIP" })).toHaveAttribute("href", downloadUrl);
      await expect(page.locator("iframe")).toHaveAttribute("src", previewUrl);
      await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      await expect(page.frameLocator("iframe").getByRole("heading", { name: "契约夹具预览" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
  });
});

test("历史契约夹具：旧分支与指定修订只读，分页保留全部成品下载", async ({ page }) => {
  await shell(page);
  const renditionId = randomUUID();
  const oldRevisionId = randomUUID();
  const ast = { schemaVersion: 1, kind: "feishu_doc", title: "旧分支正文", locks: [], speakerNotes: {}, sections: [{ id: randomUUID(), title: "历史章节", locks: [], blocks: [{ id: randomUUID(), type: "paragraph", inlines: [{ text: "旧修订原文", marks: [] }], locks: [], provenance: [{ kind: "user_assertion", messageId: randomUUID() }] }] }] };
  const revision = { schemaVersion: 1, id: revisionId, renditionId, parentId: null, templateVersionId: null, ast, createdBy: "import", reason: "原始导入", createdAt: now };
  await page.route(`**/api/v1/compositions/${contentId}`, (route) => route.fulfill({ status: 404, json: { error: { code: "COMPOSITION_NOT_FOUND", message: "旧内容", retryable: false }, requestId: randomUUID() } }));
  await envelope(page, `**/api/v1/contents/${contentId}`, { id: contentId, title: "历史项目", status: "draft", version: 1, kinds: ["feishu_doc"], renditionCount: 1, createdAt: now, updatedAt: now, brief: { schemaVersion: 1, contentId, targetKind: "feishu_doc", goal: "历史用途", audience: [], merchantId: null, durationMinutes: null, userOutline: [], mustKeepOutline: false, tone: "", sourceScope: { sourceVersionIds: [], excludeIds: [] }, unresolvedQuestions: [] }, renditions: [{ id: renditionId, kind: "feishu_doc", label: "原始分支", rootNodeId: randomUUID(), currentRevisionId: revisionId, derivedFromRevisionId: null, revision }], conversations: [] });
  const refs = { schemaVersion: 1, directRefs: [], transitiveRefs: [], blobHashes: [], bindings: [], bindingHash: "a".repeat(64) };
  await page.route(`**/api/v1/renditions/${renditionId}/revisions?*`, (route) => {
    const selected = new URL(route.request().url()).searchParams.get("revisionId");
    const data = selected === null ? { items: [{ id: oldRevisionId, renditionId, parentId: null, templateVersionId: null, createdBy: "user", reason: "早期修订", createdAt: now, evidenceHash: null, evidenceState: "empty" }], total: 1, nextCursor: null } : { ...revision, id: selected, ast: { ...ast, title: selected === oldRevisionId ? "指定的早期修订" : ast.title }, evidenceHash: null, evidence: { kind: "empty", evidence: refs }, references: [] };
    return route.fulfill({ json: { data, requestId: randomUUID() } });
  });
  const output = (name: string) => ({ schemaVersion: 1, id: randomUUID(), contentId, renditionId, renditionLabel: "原始分支", revisionId, format: "html_zip", status: "succeeded", jobId: randomUUID(), speakerNotes: false, rendererVersion: "deck-1", title: name, media: { total: 0, images: 0, gifs: 0, videos: 0, missing: [], degraded: [] }, warnings: [], artifacts: [{ id: randomUUID(), kind: "html_zip", fileName: `${name}.zip`, mime: "application/zip", bytes: 100, sha256: "a".repeat(64), downloadUrl: `/downloads/${name}.zip`, createdAt: now }], remoteDocumentId: null, remoteUrl: null, feishuBindingId: null, error: null, createdAt: now, updatedAt: now });
  const latest = output("最近成品");
  const older = { ...output("更早成品"), remoteDocumentId: "old-document", remoteUrl: "https://example.com/old-document" };
  await page.route(`**/api/v1/contents/${contentId}/exports?*`, (route) => {
    const more = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({ json: { data: { items: [more ? older : latest], total: 2, nextCursor: more ? null : "next-page" }, requestId: randomUUID() } });
  });
  const writes: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") writes.push(request.url()); });
  await page.goto(`/contents/${contentId}/edit/${renditionId}?revisionId=${oldRevisionId}`);
  await expect(page.getByRole("heading", { name: "指定的早期修订" })).toBeVisible();
  await expect(page.getByText("旧修订原文")).toBeVisible();
  await page.getByText("查看来源", { exact: true }).click();
  await expect(page.getByText(/用户陈述/)).toBeVisible();
  await page.getByRole("button", { name: "加载更多历史成品" }).click();
  await expect(page.getByRole("link", { name: "下载 最近成品.zip" })).toHaveAttribute("href", "/downloads/最近成品.zip");
  await expect(page.getByRole("link", { name: "下载 更早成品.zip" })).toHaveAttribute("href", "/downloads/更早成品.zip");
  await expect(page.getByRole("link", { name: "打开飞书文档" })).toHaveAttribute("href", "https://example.com/old-document");
  await expect(page.getByRole("button", { name: /导出|恢复|保存|接受/ })).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.goto(`/contents/${contentId}`);
  await expect(page.getByRole("heading", { name: "历史项目" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "旧分支正文" })).toBeVisible();
  expect(writes).toEqual([]);
});
