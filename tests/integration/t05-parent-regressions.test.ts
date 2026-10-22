import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  JobSnapshotSchema,
  JobGrantSchema,
  TemplateDetailSchema,
  TemplateFromSourceResultSchema,
  ValidateTemplateJobSchema,
  type ContentKind,
  type TemplateDetail,
} from "@dmall/contracts";
import { BlobStore } from "@dmall/storage";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";

async function start() {
  const evidenceRoot = process.env.DCW_TEST_EVIDENCE_ROOT;
  const root = evidenceRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const dataRoot = await mkdtemp(join(root, "t05-parent-"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (address === null || typeof address === "string") throw new Error("missing socket address");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const context = await createApp({ startWorkers: false, config: {
    ...loadConfig(), port, dataRoot, dbPath: join(dataRoot, "db/workbench.sqlite"),
    backupDir: join(dataRoot, "backups"), webRoot: join(dataRoot, "no-web"), workerPoolSize: 1,
  } });
  const base = await context.app.listen({ host: "127.0.0.1", port });
  const health = await fetch(`${base}/api/v1/health`);
  const token = z.object({ data: z.object({ csrfToken: z.string() }) }).parse(await health.json()).data.csrfToken;
  const cookie = z.string().min(1).parse(health.headers.get("set-cookie")?.split(";")[0]);
  const requests: unknown[] = [];
  const processObservations: unknown[] = [];
  async function call(path: string, body?: unknown, key = randomUUID()) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, ...(body === undefined ? {} : {
        "content-type": "application/json", "x-csrf-token": token, "idempotency-key": key,
      }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: z.unknown().parse(await response.json()) };
    requests.push({ path, key, request: body, ...result });
    return result;
  }
  const blobs = new BlobStore(dataRoot);
  await blobs.initialize();
  async function source(title: string, markdown: string | Buffer, kind = "local_markdown", mime = "text/markdown") {
    const blob = await blobs.putBytes({ bytes: Buffer.from(markdown), mime });
    const now = new Date().toISOString();
    const id = randomUUID();
    const versionId = randomUUID();
    context.database.db.prepare("INSERT OR IGNORE INTO blobs(sha256,relative_path,mime,bytes,created_at) VALUES(?,?,?,?,?)")
      .run(blob.sha256, blob.relativePath, mime, blob.bytes, now);
    context.database.db.prepare("INSERT INTO sources(id,kind,canonical_key,title,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)")
      .run(id, kind, randomUUID(), title, now, now);
    context.database.db.prepare("INSERT INTO source_versions(id,source_id,fingerprint,snapshot_blob_hash,captured_at,created_at) VALUES(?,?,?,?,?,?)")
      .run(versionId, id, blob.sha256, blob.sha256, now, now);
    return { versionId, blob };
  }
  function counts() {
    return Object.fromEntries(["templates", "template_versions", "jobs", "template_validations", "idempotency_keys"].map((table) => [
      table, z.object({ n: z.number() }).parse(context.database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n,
    ]));
  }
  async function close() {
    await context.app.close();
    await writeFile(join(dataRoot, "http-observations.json"), JSON.stringify({ base, dataRoot, requests, processObservations, closed: true }, null, 2));
    if (evidenceRoot === undefined) await rm(dataRoot, { recursive: true, force: true });
  }
  return { ...context, dataRoot, call, source, counts, processObservations, close };
}

type TestApp = Awaited<ReturnType<typeof start>>;
const request = (sourceVersionId: string, headingIds = ["md-heading-1"], kind: ContentKind = "feishu_doc") => ({
  schemaVersion: 1, sourceVersionId, selection: { headingIds }, kind,
});
const detailOf = (body: unknown) => z.object({ data: TemplateDetailSchema }).parse(body).data;
const fromSourceOf = (body: unknown) => z.object({ data: TemplateFromSourceResultSchema }).parse(body).data;

async function createValidation(app: TestApp) {
  const response = await app.call("/api/v1/templates", { schemaVersion: 1, name: "恢复验证", kind: "feishu_doc", narrativeId: "training" });
  expect(response.status).toBe(201);
  const detail = detailOf(response.body);
  const started = await app.call(`/api/v1/templates/${detail.summary.id}/validate`, { schemaVersion: 1, versionId: detail.version.id });
  expect(started.status).toBe(202);
  const jobId = z.object({ data: ValidateTemplateJobSchema }).parse(started.body).data.jobId;
  return { detail, jobId };
}

async function snapshot(app: TestApp, jobId: string) {
  return z.object({ data: JobSnapshotSchema }).parse((await app.call(`/api/v1/jobs/${jobId}`)).body).data;
}

async function readDetail(app: TestApp, detail: TemplateDetail) {
  return detailOf((await app.call(`/api/v1/templates/${detail.summary.id}?versionId=${detail.version.id}`)).body);
}

describe("PARENT-T05-01 source titles", () => {
  it.each(["题".repeat(29), "题".repeat(27) + "😀"])("preserves full UTF16 title %s and refuses ready", async (title) => {
    const app = await start();
    try {
      const heading = "章".repeat(27) + (title.endsWith("😀") ? "😀" : "章章");
      const { versionId } = await app.source(title, `# ${heading}\n`);
      const response = await app.call("/api/v1/templates/from-source", request(versionId, undefined, "html_deck"));
      expect(response.status).toBe(201);
      const result = fromSourceOf(response.body);
      if (result.status !== "draft_created") throw new Error("missing draft");
      const pkg = result.detail.version.package;
      expect(pkg.narrative.deck.slides[0]?.title).toBe(title);
      expect(pkg.narrative.deck.slides[1]?.title).toBe(heading);
      expect(pkg.narrative.doc.sections[0]?.title).toBe(heading);
      expect(result.detail.version.status).toBe("draft");
      const started = await app.call(`/api/v1/templates/${result.detail.summary.id}/validate`, { schemaVersion: 1, versionId: result.detail.version.id });
      expect(started.status).toBe(202);
      const jobId = z.object({ data: ValidateTemplateJobSchema }).parse(started.body).data.jobId;
      const assigned = app.jobs.assign(jobId, "parent-title-check");
      const { runTemplateValidation } = await import("../../apps/worker/src/template-validation.js");
      const input = assigned.grant.input;
      if (input.jobType !== "template_validate") throw new Error("wrong job input");
      const computed = await runTemplateValidation(JobGrantSchema.parse({ ...assigned.grant, workspacePath: join(app.dataRoot, "staging/jobs", jobId, `${assigned.grant.fence.attempt}-${assigned.grant.fence.leaseGeneration}`) }), new AbortController().signal);
      if (computed.jobType !== "template_validate") throw new Error("wrong result");
      expect(computed.ok).toBe(false);
      expect(computed.validation.issues).toContainEqual(expect.objectContaining({ code: "SAMPLE_INSTANTIATION_FAILED", message: expect.stringContaining("标题 29 字，超过 28 字") }));
      expect(app.jobs.finish({ fence: assigned.grant.fence, state: "failed", result: computed, error: { code: "TEMPLATE_INVALID", message: computed.message, retryable: false } })).not.toBeNull();
      const current = await readDetail(app, result.detail);
      expect(current.version.status).toBe("draft");
      expect(current.version.validation?.status).toBe("failed");
    } finally { await app.close(); }
  });
});

const fences = [
  { name: "backtick", open: "```markdown", middle: "```" },
  { name: "tilde", open: "~~~markdown", middle: "~~~" },
  { name: "four backticks short closing", open: "````markdown", middle: "```" },
  { name: "four tildes short closing", open: "~~~~markdown", middle: "~~~" },
  { name: "wrong closing marker", open: "```md", middle: "~~~" },
  { name: "trailing closing text", open: "```md", middle: "``` trailing" },
  { name: "four space closing indent", open: "```md", middle: "    ```" },
  { name: "U2028 info", open: "~~~md\u2028example", middle: "~~" },
  { name: "U2029 info", open: "```md\u2029example", middle: "``" },
  { name: "three space opening indent", open: "   ```md", middle: "```" },
];

describe("PARENT-T05-02 Markdown selections", () => {
  it.each(fences)("rejects fenced heading: $name with zero writes", async ({ name, open, middle }) => {
    const app = await start();
    try {
      const marker = open.includes("~") ? "~~~~~~" : "``````";
      const alreadyClosed = ["backtick", "tilde", "three space opening indent"].includes(name);
      const text = `${open}\n# CODE_EXAMPLE_ONLY\n${middle}\n# STILL_CODE_UNLESS_CLOSED\n${alreadyClosed ? "" : marker}\n# REAL_SECTION\n`;
      const { versionId } = await app.source("围栏", text);
      const before = app.counts();
      const response = await app.call("/api/v1/templates/from-source", request(versionId, ["md-heading-2"]));
      expect(response.status).toBe(422);
      expect(app.counts()).toEqual(before);
      const good = await app.call("/api/v1/templates/from-source", request(versionId, ["md-heading-6"]));
      expect(good.status).toBe(201);
      const result = fromSourceOf(good.body);
      if (result.status !== "draft_created") throw new Error("missing draft");
      expect(result.detail.version.package.narrative.doc.sections.map((section) => section.title)).toEqual(["REAL_SECTION"]);
    } finally { await app.close(); }
  });
  it("uses one controlled enumeration for levels 1-6, closing hashes and physical lines", async () => {
    const app = await start();
    try {
      const { versionId } = await app.source("有效标题", "# 一级\r\n ## 二级 ##\r\n   ### 三级 ### \t\r\n#### 四级\r\n##### 五级\r\n###### 六级\r\n# 标题#\r\n####### 非标题\r\n    # 缩进代码\r\n\t# 缩进代码\r\n#无空格\r\n> # 引用示例\r\n# 最后\r\n");
      const result = await app.call("/api/v1/templates/from-source", request(versionId, [1,2,3,4,5,6,7,13].map((line) => `md-heading-${line}`)));
      expect(result.status).toBe(201);
      const draft = fromSourceOf(result.body);
      if (draft.status !== "draft_created") throw new Error("missing draft");
      expect(draft.detail.version.package.narrative.doc.sections.map((section) => section.title)).toEqual(["一级", "二级", "三级", "四级", "五级", "六级", "标题#", "最后"]);
      for (const line of [8,9,10,11,12,99]) {
        const before = app.counts();
        expect((await app.call("/api/v1/templates/from-source", request(versionId, [`md-heading-${line}`]))).status).toBe(422);
        expect(app.counts()).toEqual(before);
      }
    } finally { await app.close(); }
  });
  it("requires closing fence whitespace only and at least opening length", async () => {
    const app = await start();
    try {
      const { versionId } = await app.source("围栏边界", "````md\n```\n# SHORT_CLOSING_CODE\n~~~~\n# WRONG_MARKER_CODE\n```` trailing\n# TRAILING_TEXT_CODE\n    ````\n# INDENTED_CLOSING_CODE\n   ````` \t\n###### REAL ######\n");
      for (const line of [3,5,7,9]) {
        const before = app.counts();
        expect((await app.call("/api/v1/templates/from-source", request(versionId, [`md-heading-${line}`]))).status).toBe(422);
        expect(app.counts()).toEqual(before);
      }
      const response = await app.call("/api/v1/templates/from-source", request(versionId, ["md-heading-11"]));
      expect(response.status).toBe(201);
      const result = fromSourceOf(response.body);
      if (result.status !== "draft_created") throw new Error("missing draft");
      expect(result.detail.version.package.narrative.doc.sections[0]?.title).toBe("REAL");
    } finally { await app.close(); }
  });
});

const outcomes = ["draft_created", "blocked", "missing_blob", "invalid_utf8", "no_headings"] as const;
async function outcomeSource(app: TestApp, outcome: typeof outcomes[number]) {
  const value = await app.source("并发来源", outcome === "invalid_utf8" ? Buffer.from([0xff, 0xfe]) : outcome === "no_headings" ? "正文无标题" : "# 并发章节\n", outcome === "blocked" ? "local_file" : "local_markdown", outcome === "blocked" ? "application/octet-stream" : "text/markdown");
  if (outcome === "missing_blob") await rm(join(app.dataRoot, value.blob.relativePath));
  return value.versionId;
}

describe("PARENT-T05-03 atomic from-source receipt", () => {
  it.each(outcomes)("replays concurrent and sequential complete response: %s", async (outcome) => {
    const app = await start();
    try {
      const versionId = await outcomeSource(app, outcome);
      const body = request(versionId);
      const key = randomUUID();
      const before = app.counts();
      const responses = await Promise.all([app.call("/api/v1/templates/from-source", body, key), app.call("/api/v1/templates/from-source", body, key)]);
      expect(responses.map((item) => item.status)).toEqual(outcome === "draft_created" ? [201,201] : [200,200]);
      const firstResponse = responses[0];
      if (firstResponse === undefined) throw new Error("missing response");
      const data = fromSourceOf(firstResponse.body);
      expect(data.status).toBe(outcome === "draft_created" ? "draft_created" : outcome === "blocked" ? "blocked" : "waiting_input");
      if (data.status !== "draft_created") {
        expect(data.reason).toBe(outcome === "blocked" ? "MODEL_EXTRACTION_REQUIRED" : outcome === "no_headings" ? "SOURCE_SECTIONS_UNAVAILABLE" : "CONTENT_UNAVAILABLE");
      }
      expect(responses[1]).toEqual(responses[0]);
      expect(await app.call("/api/v1/templates/from-source", body, key)).toEqual(responses[0]);
      const delta = outcome === "draft_created" ? 1 : 0;
      expect(app.counts()).toEqual({ ...before, templates: (before.templates ?? 0) + delta, template_versions: (before.template_versions ?? 0) + delta, idempotency_keys: (before.idempotency_keys ?? 0) + 1 });
      const after = app.counts();
      expect((await app.call("/api/v1/templates/from-source", { ...body, kind: "html_deck" }, key)).status).toBe(409);
      expect(app.counts()).toEqual(after);
    } finally { await app.close(); }
  });
  it.each(outcomes)("conflicts concurrently for different bodies with no extra business writes: %s", async (outcome) => {
    const app = await start();
    try {
      const versionId = await outcomeSource(app, outcome);
      const key = randomUUID();
      const before = app.counts();
      const responses = await Promise.all([app.call("/api/v1/templates/from-source", request(versionId), key), app.call("/api/v1/templates/from-source", request(versionId, undefined, "html_deck"), key)]);
      expect(responses.map((item) => item.status).sort()).toEqual(outcome === "draft_created" ? [201,409] : [200,409]);
      const delta = outcome === "draft_created" ? 1 : 0;
      expect(app.counts()).toEqual({ ...before, templates: (before.templates ?? 0) + delta, template_versions: (before.template_versions ?? 0) + delta, idempotency_keys: (before.idempotency_keys ?? 0) + 1 });
    } finally { await app.close(); }
  });
  it("preserves synchronous create, version and validation response replay", async () => {
    const app = await start();
    try {
      const createBody = { schemaVersion: 1, name: "同步幂等", kind: "feishu_doc", narrativeId: "training" };
      const createKey = randomUUID();
      const created = await app.call("/api/v1/templates", createBody, createKey);
      expect(await app.call("/api/v1/templates", createBody, createKey)).toEqual(created);
      const detail = detailOf(created.body);
      const pkg = detail.version.package;
      const versionBody = { schemaVersion: 1, baseVersionId: detail.version.id, narrative: pkg.narrative, layouts: pkg.layouts, theme: pkg.theme, slots: pkg.slots, capabilities: pkg.capabilities, changeSummary: "新版本" };
      const versionKey = randomUUID();
      const path = `/api/v1/templates/${detail.summary.id}/versions`;
      const next = await app.call(path, versionBody, versionKey);
      expect(next.status).toBe(201);
      expect(await app.call(path, versionBody, versionKey)).toEqual(next);
      const validatePath = `/api/v1/templates/${detail.summary.id}/validate`;
      const validateBody = { schemaVersion: 1, versionId: detailOf(next.body).version.id };
      const validateKey = randomUUID();
      const started = await app.call(validatePath, validateBody, validateKey);
      expect(started.status).toBe(202);
      expect(await app.call(validatePath, validateBody, validateKey)).toEqual(started);
      const after = app.counts();
      expect((await app.call(validatePath, { ...validateBody, versionId: detail.version.id }, validateKey)).status).toBe(409);
      expect(app.counts()).toEqual(after);
    } finally { await app.close(); }
  });
});

describe("PARENT-T05-04 worker exit recovery", () => {
  it("keeps attempt 1 and 2 queued, rejects old fence and fails only at max", async () => {
    const app = await start();
    try {
      const { detail, jobId } = await createValidation(app);
      for (const attempt of [1,2,3]) {
        const assigned = app.jobs.assign(jobId, `parent-recovery-${attempt}`);
        app.jobs.requeueAfterWorkerExit(jobId);
        const job = await snapshot(app, jobId);
        expect(job.attempt).toBe(attempt);
        expect(job.state).toBe(attempt === 3 ? "failed" : "queued");
        expect(job.leaseUntil).toBeNull();
        expect(job.error).toEqual(attempt === 3 ? { code: "INTERNAL_ERROR", message: "任务已达到最大重试次数", retryable: false } : null);
        const current = await readDetail(app, detail);
        expect(current.version.status).toBe("draft");
        expect(current.version.validation?.status).toBe(attempt === 3 ? "failed" : "queued");
        expect(current.version.validation?.pdfSha256).toBeNull();
        expect(app.jobs.finish({ fence: assigned.grant.fence, state: "succeeded", result: null, error: null })).toBeNull();
      }
      const before = app.counts();
      expect(app.jobs.requeueAfterWorkerExit(jobId)).toBeNull();
      expect(app.counts()).toEqual(before);
    } finally { await app.close(); }
  });
  it.each(["feishu_doc", "html_deck"] as const)("recovers a real killed worker, then readies %s only with real evidence", async (kind) => {
    const app = await start();
    try {
      const title = "题".repeat(28);
      const { versionId } = await app.source(title, `# ${"章".repeat(28)}\n`);
      const drafted = await app.call("/api/v1/templates/from-source", request(versionId, undefined, kind));
      expect(drafted.status).toBe(201);
      const result = fromSourceOf(drafted.body);
      if (result.status !== "draft_created") throw new Error("missing draft");
      const detail = result.detail;
      const started = await app.call(`/api/v1/templates/${detail.summary.id}/validate`, { schemaVersion: 1, versionId: detail.version.id });
      const jobId = z.object({ data: ValidateTemplateJobSchema }).parse(started.body).data.jobId;
      const exits: string[] = [];
      app.pool.setWorkerExitHandler((id) => {
        exits.push(id);
        app.jobs.requeueAfterWorkerExit(id);
      });
      await app.pool.start();
      const children = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n");
      const workerLine = children.find((line) => {
        const fields = line.trim().split(/\s+/u);
        return Number(fields[1]) === process.pid && line.includes("dist/apps/worker/main.js");
      });
      if (workerLine === undefined) throw new Error("missing real worker child");
      const workerPid = z.number().int().positive().parse(Number(workerLine.trim().split(/\s+/u)[0]));
      const first = app.jobs.assign(jobId, "parent-real-worker-first");
      const firstGrant = await app.imports.prepareGrant(JobGrantSchema.parse(first.grant));
      const dispatch = app.pool.dispatch(firstGrant);
      await app.pool.terminate(jobId);
      await dispatch;
      expect(exits).toEqual([jobId]);
      expect(() => process.kill(workerPid, 0)).toThrow();
      app.processObservations.push({ workerPid, workerLine, action: "pool.terminate SIGKILL", exited: true });
      const recovered = await snapshot(app, jobId);
      expect(recovered.state).toBe("queued");
      expect(recovered.attempt).toBe(1);
      expect((await readDetail(app, detail)).version.validation?.status).toBe("queued");
      const second = app.jobs.assign(jobId, "parent-real-worker-retry");
      const secondGrant = await app.imports.prepareGrant(JobGrantSchema.parse(second.grant));
      const { runTemplateValidation } = await import("../../apps/worker/src/template-validation.js");
      const computed = await runTemplateValidation(secondGrant, new AbortController().signal);
      if (computed.jobType !== "template_validate") throw new Error("wrong result");
      expect(computed.ok, JSON.stringify(computed.validation.issues)).toBe(true);
      expect(computed.evidence?.source).toBe("chromium");
      expect(computed.evidence?.print.pdfBytes).toBeGreaterThan(0);
      expect(app.jobs.finish({ fence: first.grant.fence, state: "succeeded", result: computed, error: null })).toBeNull();
      expect((await readDetail(app, detail)).version.status).toBe("draft");
      expect(app.jobs.finish({ fence: second.grant.fence, state: "succeeded", result: computed, error: null })).not.toBeNull();
      const current = await readDetail(app, detail);
      expect(current.version.status).toBe("ready");
      expect(current.version.validation?.status).toBe("passed");
      expect(current.version.validation?.pdfSha256).toBe(computed.evidence?.print.pdfSha256);
      expect((await snapshot(app, jobId)).attempt).toBe(2);
      app.processObservations.push({ retryComputation: "real runTemplateValidation in test host", templateKind: kind, evidence: computed.evidence });
    } finally { await app.close(); }
  }, 60_000);
  it("honors cancellation during worker exit and never readies", async () => {
    const app = await start();
    try {
      const { detail, jobId } = await createValidation(app);
      const assigned = app.jobs.assign(jobId, "parent-cancel-recovery");
      expect((await app.call(`/api/v1/jobs/${jobId}/cancel`, {})).status).toBe(200);
      app.jobs.requeueAfterWorkerExit(jobId);
      expect((await snapshot(app, jobId)).state).toBe("cancelled");
      const current = await readDetail(app, detail);
      expect(current.version.status).toBe("draft");
      expect(current.version.validation?.status).toBe("cancelled");
      expect(app.jobs.finish({ fence: assigned.grant.fence, state: "succeeded", result: null, error: null })).toBeNull();
    } finally { await app.close(); }
  });
});
