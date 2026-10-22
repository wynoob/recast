import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  JobSnapshot,
  TemplateDetail,
  TemplateList,
  ValidateTemplateJob,
} from "@dmall/contracts";
import { createApp, type AppContext } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { BlobStore } from "@dmall/storage";

const roots: string[] = [];

interface TestApp {
  context: AppContext;
  dataRoot: string;
  app: FastifyInstance;
  base: string;
  cookie: string;
  csrf: string;
}

async function startApp(startWorkers: boolean): Promise<TestApp> {
  const dataRoot = await mkdtemp(join(tmpdir(), "dcw-t05-product-"));
  roots.push(dataRoot);
  const baseConfig = loadConfig();
  const context = await createApp({
    startWorkers,
    config: {
      ...baseConfig,
      dataRoot,
      dbPath: join(dataRoot, "db", "workbench.sqlite"),
      backupDir: join(dataRoot, "backups"),
      webRoot: join(dataRoot, "no-web"),
      workerPoolSize: 1,
    },
  });
  const health = await context.app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: { host: "127.0.0.1:4318" },
  });
  const body = JSON.parse(health.body) as { data: { csrfToken: string } };
  const setCookie = health.headers["set-cookie"];
  const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (rawCookie === undefined) throw new Error("missing session cookie");
  return {
    context,
    dataRoot,
    app: context.app,
    base: "http://127.0.0.1:4318",
    cookie: rawCookie.split(";")[0] ?? "",
    csrf: body.data.csrfToken,
  };
}

async function write(
  app: TestApp,
  method: "POST",
  url: string,
  body: unknown,
  key = randomUUID(),
): Promise<{ status: number; body: unknown }> {
  const response = await app.app.inject({
    method,
    url,
    headers: {
      host: "127.0.0.1:4318",
      cookie: app.cookie,
      "x-csrf-token": app.csrf,
      "idempotency-key": key,
    },
    payload: body,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as unknown };
}

async function read(app: TestApp, url: string): Promise<unknown> {
  const response = await app.app.inject({
    method: "GET",
    url,
    headers: { host: "127.0.0.1:4318", cookie: app.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return JSON.parse(response.body) as unknown;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T05 template HTTP and SQLite lifecycle", () => {
  it("creates, filters, versions and keeps old snapshots readable", async () => {
    const app = await startApp(false);
    try {
      const key = randomUUID();
      const created = await write(app, "POST", "/api/v1/templates", {
        schemaVersion: 1,
        name: "产品介绍基础模板",
        kind: "feishu_doc",
        narrativeId: "product-intro",
      }, key);
      expect(created.status).toBe(201);
      const first = (created.body as { data: TemplateDetail }).data;
      expect(first.summary.status).toBe("draft");
      expect(first.summary.validationStatus).toBe("not_validated");
      expect(first.version.package.manifest.templateVersionId).toBe(first.version.id);

      const replay = await write(app, "POST", "/api/v1/templates", {
        schemaVersion: 1,
        name: "产品介绍基础模板",
        kind: "feishu_doc",
        narrativeId: "product-intro",
      }, key);
      expect(replay.status).toBe(201);
      expect((replay.body as { data: TemplateDetail }).data.summary.id).toBe(first.summary.id);

      const conflict = await write(app, "POST", "/api/v1/templates", {
        schemaVersion: 1,
        name: "不同请求",
        kind: "feishu_doc",
        narrativeId: "product-intro",
      }, key);
      expect(conflict.status).toBe(409);

      const list = (await read(app, "/api/v1/templates?kind=feishu_doc&status=draft")) as {
        data: TemplateList;
      };
      expect(list.data.total).toBe(1);
      expect(list.data.items[0]?.narrativeId).toBe("product-intro");

      const changedNarrative = {
        ...first.version.package.narrative,
        summary: `${first.version.package.narrative.summary} 新版本修订`,
      };
      const next = await write(app, "POST", `/api/v1/templates/${first.summary.id}/versions`, {
        schemaVersion: 1,
        baseVersionId: first.version.id,
        narrative: changedNarrative,
        layouts: first.version.package.layouts,
        theme: first.version.package.theme,
        slots: first.version.package.slots,
        capabilities: first.version.package.capabilities,
        changeSummary: "调整叙事摘要",
      });
      expect(next.status).toBe(201);
      const second = (next.body as { data: TemplateDetail }).data;
      expect(second.version.version).toBe(2);
      expect(second.version.baseVersionId).toBe(first.version.id);
      expect(second.summary.status).toBe("draft");

      const old = (await read(
        app,
        `/api/v1/templates/${first.summary.id}?versionId=${first.version.id}`,
      )) as { data: TemplateDetail };
      expect(old.data.version.package.narrative.summary).toBe(first.version.package.narrative.summary);
      expect(old.data.version.package.manifest.templateVersionId).toBe(first.version.id);

      const archived = await write(
        app,
        "POST",
        `/api/v1/templates/${first.summary.id}/archive`,
        {
          schemaVersion: 1,
          versionId: first.version.id,
          expectedStatus: "draft",
        },
      );
      expect(archived.status).toBe(200);
      const archivedRead = (await read(
        app,
        `/api/v1/templates/${first.summary.id}?versionId=${first.version.id}`,
      )) as { data: TemplateDetail };
      expect(archivedRead.data.version.status).toBe("archived");
      expect(archivedRead.data.version.package.narrative.summary).toBe(first.version.package.narrative.summary);
      const latestRead = (await read(
        app,
        `/api/v1/templates/${first.summary.id}`,
      )) as { data: TemplateDetail };
      expect(latestRead.data.version.id).toBe(second.version.id);
      expect(latestRead.data.version.status).toBe("draft");
    } finally {
      await app.context.app.close();
    }
  });

  it("records cancellation without promoting a template", async () => {
    const app = await startApp(false);
    try {
      const created = await write(app, "POST", "/api/v1/templates", {
        schemaVersion: 1,
        name: "取消验证模板",
        kind: "html_deck",
        narrativeId: "phase-review",
      });
      const detail = (created.body as { data: TemplateDetail }).data;
      const started = await write(app, "POST", `/api/v1/templates/${detail.summary.id}/validate`, {
        schemaVersion: 1,
        versionId: detail.version.id,
      });
      expect(started.status).toBe(202);
      const jobId = (started.body as { data: ValidateTemplateJob }).data.jobId;
      const cancelled = await write(app, "POST", `/api/v1/jobs/${jobId}/cancel`, {});
      expect(cancelled.status).toBe(200);
      const after = (await read(
        app,
        `/api/v1/templates/${detail.summary.id}?versionId=${detail.version.id}`,
      )) as { data: TemplateDetail };
      expect(after.data.version.status).toBe("draft");
      expect(after.data.version.validation?.status).toBe("cancelled");
    } finally {
      await app.context.app.close();
    }
  });

  it("rejects stale fence before template finalization", async () => {
    const app = await startApp(false);
    try {
      const created = await write(app, "POST", "/api/v1/templates", {
        schemaVersion: 1,
        name: "fence 模板",
        kind: "feishu_doc",
        narrativeId: "training",
      });
      const detail = (created.body as { data: TemplateDetail }).data;
      const started = await write(app, "POST", `/api/v1/templates/${detail.summary.id}/validate`, {
        schemaVersion: 1,
        versionId: detail.version.id,
      });
      const jobId = (started.body as { data: ValidateTemplateJob }).data.jobId;
      const assigned = app.context.jobs.assign(jobId, `test:${process.pid}`);
      app.context.database.db
        .prepare("UPDATE jobs SET lease_generation = lease_generation + 1 WHERE id = ?")
        .run(jobId);
      const accepted = app.context.jobs.finish({
        fence: assigned.grant.fence,
        state: "failed",
        result: null,
        error: { code: "TEMPLATE_INVALID", message: "stale", retryable: false },
      });
      expect(accepted).toBeNull();
      const after = (await read(
        app,
        `/api/v1/templates/${detail.summary.id}?versionId=${detail.version.id}`,
      )) as { data: TemplateDetail };
      expect(after.data.version.status).toBe("draft");
    } finally {
      await app.context.app.close();
    }
  });

  it("runs Chromium, persists evidence and promotes only after real success", async () => {
    const app = await startApp(true);
    try {
      const created = await write(app, "POST", "/api/v1/templates", {
        schemaVersion: 1,
        name: "真实验证文档模板",
        kind: "feishu_doc",
        narrativeId: "product-intro",
      });
      const detail = (created.body as { data: TemplateDetail }).data;
      const started = await write(app, "POST", `/api/v1/templates/${detail.summary.id}/validate`, {
        schemaVersion: 1,
        versionId: detail.version.id,
      });
      expect(started.status).toBe(202);
      const jobId = (started.body as { data: ValidateTemplateJob }).data.jobId;
      const job = await waitForJob(app, jobId);
      expect(job.state, JSON.stringify(job)).toBe("succeeded");
      expect(job.result?.jobType).toBe("template_validate");
      if (job.result?.jobType !== "template_validate") throw new Error("missing template result");
      expect(job.result.ok).toBe(true);
      expect(job.result.validation.ok).toBe(true);
      expect(job.result.evidence?.source).toBe("chromium");
      expect(job.result.artifacts).not.toBeNull();

      const after = (await read(
        app,
        `/api/v1/templates/${detail.summary.id}?versionId=${detail.version.id}`,
      )) as { data: TemplateDetail };
      expect(after.data.version.status).toBe("ready");
      expect(after.data.version.validation?.status).toBe("passed");
      expect(after.data.version.validation?.report?.readyReview?.decision).toBe("pass");
      const pdfPath = after.data.version.validation?.pdfPath;
      expect(pdfPath).not.toBeNull();
      if (pdfPath === null || pdfPath === undefined) throw new Error("missing PDF path");
      const pdfHash = await hashFile(join(app.dataRoot, pdfPath));
      expect(pdfHash).toBe(after.data.version.validation?.pdfSha256);

      const nextDraft = await write(
        app,
        "POST",
        `/api/v1/templates/${detail.summary.id}/versions`,
        {
          schemaVersion: 1,
          baseVersionId: after.data.version.id,
          narrative: after.data.version.package.narrative,
          layouts: after.data.version.package.layouts,
          theme: after.data.version.package.theme,
          slots: after.data.version.package.slots,
          capabilities: after.data.version.package.capabilities,
          changeSummary: "ready 后建立新草稿",
        },
      );
      expect(nextDraft.status).toBe(201);
      const oldReady = (await read(
        app,
        `/api/v1/templates/${detail.summary.id}?versionId=${after.data.version.id}`,
      )) as { data: TemplateDetail };
      expect(oldReady.data.version.status).toBe("ready");
      const latest = (await read(
        app,
        `/api/v1/templates/${detail.summary.id}`,
      )) as { data: TemplateDetail };
      expect(latest.data.version.version).toBe(2);
      expect(latest.data.version.status).toBe("draft");
    } finally {
      await app.context.app.close();
    }
  }, 60_000);

  it("keeps a title-overflow template in draft with the real failure report", async () => {
    const app = await startApp(true);
    try {
      const created = await write(app, "POST", "/api/v1/templates", {
        schemaVersion: 1,
        name: "标题超限演示模板",
        kind: "html_deck",
        narrativeId: "phase-review",
      });
      const detail = (created.body as { data: TemplateDetail }).data;
      const narrative = structuredClone(detail.version.package.narrative);
      const cover = narrative.deck.slides.find((slide) => slide.layout === "cover");
      if (cover === undefined) throw new Error("cover slide missing");
      cover.title = "题".repeat(29);
      const next = await write(app, "POST", `/api/v1/templates/${detail.summary.id}/versions`, {
        schemaVersion: 1,
        baseVersionId: detail.version.id,
        narrative,
        layouts: detail.version.package.layouts,
        theme: detail.version.package.theme,
        slots: detail.version.package.slots,
        capabilities: detail.version.package.capabilities,
        changeSummary: "标题超限失败用例",
      });
      const version = (next.body as { data: TemplateDetail }).data;
      const started = await write(app, "POST", `/api/v1/templates/${detail.summary.id}/validate`, {
        schemaVersion: 1,
        versionId: version.version.id,
      });
      const jobId = (started.body as { data: ValidateTemplateJob }).data.jobId;
      const job = await waitForJob(app, jobId);
      expect(job.state).toBe("failed");
      const after = (await read(
        app,
        `/api/v1/templates/${detail.summary.id}?versionId=${version.version.id}`,
      )) as { data: TemplateDetail };
      expect(after.data.version.status).toBe("draft");
      expect(after.data.version.validation?.status).toBe("failed");
      expect(
        after.data.version.validation?.report?.issues.some((item) =>
          item.code === "TITLE_CAPACITY_EXCEEDED" || item.message.includes("29"),
        ),
      ).toBe(true);
    } finally {
      await app.context.app.close();
    }
  }, 60_000);

  it("creates a deterministic Markdown draft and reports blocked non-text sources", async () => {
    const app = await startApp(false);
    try {
      const db = app.context.database.db;
      const blobs = new BlobStore(app.dataRoot);
      await blobs.initialize();
      const markdown = "# 目标\n\n说明\n\n## 交付\n\n内容\n\n## 行动\n";
      const markdownBlob = await blobs.putBytes({
        bytes: Buffer.from(markdown),
        mime: "text/markdown",
      });
      const sourceId = randomUUID();
      const versionId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at)
         VALUES (?, ?, 'text/markdown', ?, ?)`,
      ).run(markdownBlob.sha256, markdownBlob.relativePath, markdownBlob.bytes, now);
      db.prepare(
        `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
         VALUES (?, 'local_markdown', 't05-source', '阶段材料', NULL, 'active', ?, ?)`,
      ).run(sourceId, now, now);
      db.prepare(
        `INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(versionId, sourceId, "a".repeat(64), markdownBlob.sha256, now, now);

      const drafted = await write(app, "POST", "/api/v1/templates/from-source", {
        schemaVersion: 1,
        sourceVersionId: versionId,
        selection: { headingIds: ["md-heading-1", "md-heading-5"] },
        kind: "feishu_doc",
      });
      expect(drafted.status).toBe(201);
      const result = (drafted.body as {
        data: {
          status: string;
          reviewRequired: boolean;
          detail: TemplateDetail;
        };
      }).data;
      expect(result.status).toBe("draft_created");
      expect(result.reviewRequired).toBe(true);
      expect(result.detail.version.package.narrative.doc.sections.map((section) => section.title)).toEqual([
        "目标",
        "交付",
      ]);
      expect(result.detail.version.package.manifest.changeSummary).toContain("人工检查");

      const binaryBlob = await blobs.putBytes({
        bytes: Buffer.from("not markdown"),
        mime: "application/octet-stream",
      });
      const binarySourceId = randomUUID();
      const binaryVersionId = randomUUID();
      db.prepare(
        `INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at)
         VALUES (?, ?, 'application/octet-stream', ?, ?)`,
      ).run(binaryBlob.sha256, binaryBlob.relativePath, binaryBlob.bytes, now);
      db.prepare(
        `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
         VALUES (?, 'local_file', 't05-binary-source', '二进制材料', NULL, 'active', ?, ?)`,
      ).run(binarySourceId, now, now);
      db.prepare(
        `INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(binaryVersionId, binarySourceId, "b".repeat(64), binaryBlob.sha256, now, now);
      const blocked = await write(app, "POST", "/api/v1/templates/from-source", {
        schemaVersion: 1,
        sourceVersionId: binaryVersionId,
        selection: { headingIds: ["anything"] },
        kind: "feishu_doc",
      });
      expect(blocked.status).toBe(200);
      expect((blocked.body as { data: { status: string; reason: string } }).data).toMatchObject({
        status: "blocked",
        reason: "MODEL_EXTRACTION_REQUIRED",
      });
    } finally {
      await app.context.app.close();
    }
  });
});

async function waitForJob(app: TestApp, jobId: string): Promise<JobSnapshot> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = (await read(app, `/api/v1/jobs/${jobId}`)) as { data: JobSnapshot };
    if (["succeeded", "failed", "cancelled", "partial"].includes(response.data.state)) {
      return response.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
