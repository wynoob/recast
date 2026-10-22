import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AstSchema, CreateContentRequestSchema, JobGrantSchema, type JobCheckpoint } from "@dmall/contracts";
import { buildBuiltinTemplatePackage } from "@dmall/templates";
import { FeishuApiError, FeishuClient, type FeishuBlock } from "../../apps/worker/src/feishu-client.js";
import { RemoteResultUnknownError, runFeishuPublishJob, type OutputJobDeps } from "../../apps/worker/src/outputs.js";
import { RemoteOperationRepository } from "../../apps/server/src/remote-operations.js";
import { ContentRepository } from "../../apps/server/src/content-repository.js";
import { IdempotencyRepository } from "../../apps/server/src/idempotency.js";
import { startT02cApp, type T02cTestApp } from "./t02c-test-helpers.js";

const apps: T02cTestApp[] = [], roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const app of apps.splice(0)) { await app.close(); await rm(app.config.dataRoot, { recursive: true, force: true }); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function fakeFeishu() {
  vi.stubEnv("DCW_FEISHU_USER_ACCESS_TOKEN", "fixture-token-not-a-real-credential");
  const blocks: FeishuBlock[] = [];
  const tokens = new Map<string, FeishuBlock[]>();
  const cells = new Map<string, FeishuBlock[]>();
  let failCell = false, failPatch = false;
  const create = vi.spyOn(FeishuClient.prototype, "createDocument").mockResolvedValue({
    documentId: "original-doc", revisionId: "1", title: "夹具", url: "https://feishu.cn/docx/original-doc",
  });
  const children = vi.spyOn(FeishuClient.prototype, "createChildren").mockImplementation(async (input) => {
    expect(input.documentId).toBe("original-doc");
    if (failCell && input.parentBlockId.startsWith("cell-1")) { failCell = false; throw new FeishuApiError("授权过期", 1, 401, false); }
    const saved = tokens.get(input.clientToken); if (saved !== undefined) return { children: saved, revisionId: null };
    const result = input.children.map((payload) => {
      const parsed = z.record(z.string(), z.unknown()).parse(payload);
      const block: FeishuBlock = { ...parsed, block_id: `block-${blocks.length}`, block_type: z.number().parse(parsed.block_type) };
      if (block.block_type === 31) {
        const table = z.object({ property: z.object({ row_size: z.number(), column_size: z.number() }) }).parse(block.table);
        const tableCells = Array.from({ length: table.property.row_size * table.property.column_size }, (_, index) => ({ block_id: `cell-${index}-${block.block_id}`, block_type: 32 }));
        block.table = { ...table, cells: tableCells.map((cell) => cell.block_id) }; cells.set(block.block_id, tableCells);
      }
      blocks.push(block); return block;
    });
    tokens.set(input.clientToken, result); return { children: result, revisionId: null };
  });
  const upload = vi.spyOn(FeishuClient.prototype, "uploadImage").mockImplementation(async (input) => `token-${input.blockId}`);
  const patch = vi.spyOn(FeishuClient.prototype, "patchBlock").mockImplementation(async (input) => {
    if (failPatch) { failPatch = false; throw new FeishuApiError("权限暂时失效", 1, 403, false); }
    const block = blocks.find((value) => value.block_id === input.blockId); if (block === undefined) throw new Error("missing image block");
    block.image = z.object({ replace_image: z.object({ token: z.string() }) }).parse(input.body).replace_image;
    return null;
  });
  vi.spyOn(FeishuClient.prototype, "listChildren").mockImplementation(async (input) => ({ items: cells.get(input.parentBlockId) ?? [], hasMore: false, pageToken: null }));
  vi.spyOn(FeishuClient.prototype, "listBlocks").mockImplementation(async () => ({ items: blocks, hasMore: false, pageToken: null }));
  return { blocks, create, children, upload, patch,
    failNextCell() { failCell = true; }, failNextPatch() { failPatch = true; } };
}

async function workerFixture() {
  const root = await mkdtemp(join(tmpdir(), "composer-feishu-")); roots.push(root);
  const mediaBytes = Buffer.from("fixture-image"); await writeFile(join(root, "image.png"), mediaBytes);
  const tableId = randomUUID(), firstImage = randomUUID(), secondImage = randomUUID(), assetVersionId = randomUUID();
  const ast = AstSchema.parse({ schemaVersion: 1, kind: "feishu_doc", title: "夹具完整文档", speakerNotes: {}, sections: [
    { id: randomUUID(), title: "库存方案", blocks: [
      { id: randomUUID(), type: "paragraph", inlines: [{ text: "核对库存", marks: [] }] },
      { id: tableId, type: "table", columns: ["阶段", "操作"], rows: [[[{ text: "本周", marks: [] }], [{ text: "盘点", marks: [] }]]] },
      ...[firstImage, secondImage].map((id) => ({ id, type: "image", assetVersionId, derivativeId: null, occurrenceId: randomUUID(), caption: "库存图片", alt: "库存图片", fit: "contain" })),
    ] },
  ] });
  const jobId = randomUUID();
  const grant = JobGrantSchema.parse({ schemaVersion: 1, jobId, fence: { jobId, attempt: 1, leaseOwner: "fixture", leaseGeneration: 1 },
    inputHash: hash("feishu"), checkpoint: null, blobRoot: root, workspacePath: root,
    input: { schemaVersion: 1, jobType: "feishu_publish", exportId: randomUUID(), contentId: randomUUID(), renditionId: randomUUID(), revisionId: randomUUID(),
      title: ast.title, ast, templateVersionId: null, templatePackage: buildBuiltinTemplatePackage("product-intro", "feishu_doc"),
      options: { speakerNotes: false, includeHiddenBlocks: false }, folderToken: "fixed-folder",
      media: [{ key: `asset_version:${assetVersionId}`, role: "image", mediaKind: "image", assetVersionId,
        assetId: null, derivativeId: null, occurrenceId: null, segmentId: null, blobHash: hash(mediaBytes),
        relativePath: "image.png", mime: "image/png", bytes: mediaBytes.length, originalName: "image.png" }],
    } });
  return { grant, tableId, firstImage, secondImage };
}

describe("composition Feishu delivery", () => {
  it("continues partial tables and media in the original document without recreating or reuploading completed work", async () => {
    const fake = fakeFeishu(); const { grant, tableId, firstImage, secondImage } = await workerFixture();
    let checkpoint: JobCheckpoint | null = null;
    const deps: OutputJobDeps = { emitCheckpoint(value) { checkpoint = structuredClone(value); }, emitProgress() {},
      async waitForInput(value) { checkpoint = value; }, async withRemoteOperation(_input, action) { return action(); } };
    fake.failNextCell();
    await expect(runFeishuPublishJob(grant, deps)).rejects.toThrow("授权过期");
    expect(checkpoint).toMatchObject({ documentId: "original-doc", blockMap: { [`${tableId}:cell:0`]: expect.any(String) } });
    fake.failNextPatch();
    await expect(runFeishuPublishJob({ ...grant, checkpoint }, deps)).rejects.toThrow("权限暂时失效");
    expect(fake.upload).toHaveBeenCalledTimes(1);
    const result = await runFeishuPublishJob({ ...grant, checkpoint }, deps);
    expect(result?.documentId).toBe("original-doc"); expect(result?.warnings).toEqual([]);
    expect(fake.create).toHaveBeenCalledTimes(1); expect(fake.create).toHaveBeenCalledWith({ title: "夹具完整文档", folderToken: "fixed-folder" });
    expect(fake.upload).toHaveBeenCalledTimes(2);
    expect(result?.mediaMap[firstImage]).toBeDefined(); expect(result?.mediaMap[secondImage]).toBeDefined();
    expect(fake.children.mock.calls.filter(([call]) => call.parentBlockId.startsWith("cell-0"))).toHaveLength(1);
    const childrenAfterSuccess = fake.children.mock.calls.length;
    fake.blocks.splice(fake.blocks.findIndex((block) => block.block_id === result?.blockMap[firstImage]), 1);
    const partial = await runFeishuPublishJob({ ...grant, checkpoint }, deps);
    expect(partial?.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FEISHU_READBACK_MISMATCH" })]));
    expect(fake.create).toHaveBeenCalledTimes(1); expect(fake.children).toHaveBeenCalledTimes(childrenAfterSuccess);
  });

  it("requires verified binding for a lost create response and resumes the same job with permanent decision replay", async () => {
    const fake = fakeFeishu();
    const app = await startT02cApp(); apps.push(app);
    const db = app.context.database.db;
    const columns = z.array(z.object({ name: z.string() })).parse(db.prepare("PRAGMA table_info(exports)").all());
    if (!columns.some((column) => column.name === "business_key")) {
      db.exec(`ALTER TABLE exports ADD COLUMN business_key TEXT;
        CREATE UNIQUE INDEX test_composition_export_key ON exports(business_key);
        ALTER TABLE exports ADD COLUMN composition_request_hash TEXT;
        ALTER TABLE output_job_decisions ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0;`);
    }
    const content = new ContentRepository(db, new IdempotencyRepository(db)).create(
      CreateContentRequestSchema.parse({ schemaVersion: 1, kind: "feishu_doc", title: "丢回执夹具" }),
      { routeScope: "fixture-feishu", key: randomUUID(), requestHash: hash("doc-content"), requestId: randomUUID() },
    );
    const rendition = content.renditions[0]; if (rendition === undefined) throw new Error("missing rendition");
    const input = { contentId: content.id, renditionId: rendition.id, revisionId: rendition.currentRevisionId,
      target: { kind: "feishu_doc" as const, folderToken: "fixed-folder" }, exportId: randomUUID(), jobId: randomUUID(), businessKey: `composition:${content.id}:delivery`, requestHash: hash("lost-create") };
    await app.context.outputs.createForComposition(input);
    const grant = await app.context.outputs.prepareGrant(app.context.jobs.assign(input.jobId, "lost-response").grant);
    const remote = new RemoteOperationRepository(db); let operationId = "";
    const deps: OutputJobDeps = {
      emitCheckpoint(checkpoint) { app.context.jobs.checkpoint(grant.fence, checkpoint); }, emitProgress() {},
      async waitForInput(checkpoint, reason, message) { app.context.jobs.waitForInput(grant.fence, checkpoint, reason, message); },
      async withRemoteOperation(operation, action) {
        const prepared = remote.prepare({ jobId: grant.jobId, attempt: grant.fence.attempt, leaseGeneration: grant.fence.leaseGeneration,
          kind: operation.kind, requestHash: operation.requestHash, remoteClientToken: operation.clientToken });
        operationId = prepared.operationId;
        const identity = { operationId, attempt: grant.fence.attempt, leaseGeneration: grant.fence.leaseGeneration };
        remote.markDispatched({ ...identity, requestHash: operation.requestHash });
        await action(); remote.markUnknown(identity); throw new RemoteResultUnknownError("response lost after create");
      },
    };
    expect(await runFeishuPublishJob(grant, deps)).toBeNull();
    expect(fake.create).toHaveBeenCalledTimes(1); expect(app.context.outputs.get(input.exportId).status).toBe("waiting_input");
    await expect(app.context.outputs.prepareGrant(grant)).rejects.toMatchObject({ code: "REMOTE_RESULT_UNKNOWN" });
    const retry = { exportId: input.exportId, expectedDecisionVersion: 0, decision: { kind: "retry_original" as const }, commandId: randomUUID(), requestHash: hash("retry") };
    await expect(app.context.outputs.resumeForComposition(retry)).rejects.toMatchObject({ code: "REMOTE_RESULT_UNKNOWN" });
    expect(() => app.context.outputs.retryExport(input.exportId)).toThrow();
    const decision = { ...retry, decision: { kind: "bind_verified_document" as const, operationId, documentId: "original-doc", confirmedOriginal: true as const }, commandId: randomUUID(), requestHash: hash("verified-binding") };
    await expect(app.context.outputs.resumeForComposition({ ...decision, decision: { ...decision.decision, operationId: randomUUID() } })).rejects.toMatchObject({ code: "JOB_NOT_RESUMABLE" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      expect(db.inTransaction).toBe(false);
      return new Response(JSON.stringify({ code: 0, data: { document: { document_id: "original-doc" } } }), { status: 200 });
    }));
    await app.context.outputs.resumeForComposition(decision);
    await app.context.outputs.resumeForComposition(decision);
    await app.context.outputs.resumeForComposition({ ...decision, commandId: randomUUID() });
    await expect(app.context.outputs.resumeForComposition({ ...retry, commandId: randomUUID() })).rejects.toMatchObject({ code: "JOB_NOT_RESUMABLE" });
    expect(db.prepare("SELECT decision_version FROM output_job_decisions WHERE job_id = ?").get(input.jobId)).toEqual({ decision_version: 1 });
    await expect(app.context.outputs.resumeForComposition({ ...decision, requestHash: hash("different") })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const resumed = await app.context.outputs.prepareGrant(app.context.jobs.assign(input.jobId, "bound-original").grant);
    const result = await runFeishuPublishJob(resumed, { emitCheckpoint(value) { app.context.jobs.checkpoint(resumed.fence, value); }, emitProgress() {},
      async waitForInput() { throw new Error("verified original must not request create"); }, async withRemoteOperation(_operation, action) { return action(); } });
    if (result === null) throw new Error("missing final result");
    app.context.jobs.finish({ fence: resumed.fence, result, state: "succeeded", error: null });
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(app.context.outputs.get(input.exportId)).toMatchObject({ status: "succeeded", jobId: input.jobId, remoteDocumentId: "original-doc" });
  });
});
