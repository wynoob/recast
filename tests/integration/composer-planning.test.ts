import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CompositionViewSchema, TemplatePackageSchema, type Proposal, type WorkerFence } from "@dmall/contracts";
import { buildBuiltinTemplatePackage, canonicalHash } from "@dmall/templates";
import { BlobStore } from "@dmall/storage";
import { startT02cApp, type T02cTestApp } from "./t02c-test-helpers.js";
import { sha256, stableJson, commitRevision } from "../../apps/server/src/authoring/revision-commit.js";

const apps: T02cTestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) { await app.close(); await rm(app.config.dataRoot, { recursive: true, force: true }); }
});

async function fixture(kind: "feishu_doc" | "html_deck" = "feishu_doc") {
  const app = await startT02cApp();
  apps.push(app);
  const db = app.context.database.db;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO provider_configs(id, role, base_url, model_id, capabilities_json, keychain_ref, created_at, updated_at) VALUES (?, 'text', 'http://127.0.0.1:1/v1', 'counted-fixture', ?, 'COMPOSER_TEST_KEY', ?, ?)")
    .run(randomUUID(), JSON.stringify({ verified: true }), now, now);
  const pkg = buildBuiltinTemplatePackage("training", kind);
  pkg.manifest.id = randomUUID();
  pkg.manifest.templateVersionId = randomUUID();
  pkg.manifest.status = "ready";
  pkg.narrative.doc.sections = [{ id: "steps", title: "库存步骤", purpose: "介绍操作", requiredEvidence: [] }];
  pkg.slots = [{ id: "steps-body", containerId: "steps", order: 0, blockType: "paragraph", label: "正文", required: true,
    capacity: { maxCharacters: kind === "feishu_doc" ? 1000 : 180 }, source: { kind: "default", value: { kind: "text", text: "此处只作写作指导" } } }];
  if (kind === "html_deck") {
    pkg.narrative.deck.slides = [{ id: "steps", title: "库存步骤", purpose: "说明操作", layout: "title-body-media" }];
    pkg.layouts = pkg.layouts.filter((layout) => layout.id === "title-body-media");
    pkg.slots = pkg.slots.map((slot) => ({ ...slot, layoutSlotId: "body" }));
  }
  const template = TemplatePackageSchema.parse(pkg);
  db.prepare("INSERT INTO templates(id, kind, name, created_at, updated_at) VALUES (?, ?, '测试模板', ?, ?)").run(pkg.manifest.id, kind, now, now);
  db.prepare(`INSERT INTO template_versions(id, template_id, version, kind, narrative_json, layout_json, theme_json, capabilities_json, status, created_at, package_json, package_hash, slots_json, renderer_version)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`)
    .run(pkg.manifest.templateVersionId, pkg.manifest.id, kind, JSON.stringify(pkg.narrative), JSON.stringify(pkg.layouts), JSON.stringify(pkg.theme), JSON.stringify(pkg.capabilities), now, JSON.stringify(pkg), canonicalHash(pkg), JSON.stringify(pkg.slots), pkg.rendererVersion);
  const merchantId = randomUUID();
  const sourceId = randomUUID();
  const sourceVersionId = randomUUID();
  const sectionId = randomUUID();
  const text = "库存核对流程：先检查库存，再按缺口补货。";
  const bytes = Buffer.from(text);
  const hash = sha256(text);
  const blobs = new BlobStore(app.config.dataRoot);
  await blobs.putBytes({ bytes, expectedSha256: hash, mime: "text/plain" });
  db.prepare("INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, 'text/plain', ?, ?)").run(hash, blobs.relativePathForHash(hash), bytes.length, now);
  db.prepare("INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at) VALUES (?, 'local', ?, '门店库存原文', NULL, 'active', ?, ?)").run(sourceId, sourceId, now, now);
  db.prepare("INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(sourceVersionId, sourceId, hash, hash, now, now);
  const locator = { kind: "block" as const, blockId: "steps" };
  db.prepare("INSERT INTO document_sections(id, source_version_id, adapter_id, ordinal, title, heading_path, text, locator_json, notes, created_at) VALUES (?, ?, 'steps', 1, '库存步骤', '库存步骤', ?, ?, '', ?)").run(sectionId, sourceVersionId, text, JSON.stringify(locator), now);
  app.context.index.insertDocumentChunks({ sourceVersionId, drafts: [{ sectionAdapterId: "steps", chunkId: randomUUID(), chunkKind: "text", text, title: "库存步骤", tags: [], merchantId,
    mediaKind: "document", recordDate: null, effectiveFrom: null, effectiveTo: null, audience: [], functions: [], obsolete: false, availability: "available", locationKey: "steps", contentHash: hash, blockAdapterIds: [], overlapChars: 0 }],
    sectionIdByAdapter: new Map([["steps", sectionId]]), blockIdByAdapter: new Map(), blockLocatorById: new Map(), sectionLocatorById: new Map([["steps", locator]]), now });
  app.context.index.rebuild();
  return { app, merchantId, template, sourceVersionId };
}

function view(response: unknown) { return z.object({ data: CompositionViewSchema }).parse(response).data; }
async function submit(app: T02cTestApp, key = randomUUID()) {
  const response = await app.rawJson("POST", "/api/v1/compositions/submit", { mode: "create", idea: "给店长说明库存核对", delivery: { kind: "feishu_doc", folderToken: null } }, key);
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return view(response.body);
}
function latest(app: T02cTestApp, contentId: string, task: string, version?: number) {
  const raw = app.context.database.db.prepare(`SELECT id FROM jobs WHERE type = 'composition_provider' AND json_extract(input_json, '$.contentId') = ? AND json_extract(input_json, '$.task') = ? ${version === undefined ? "" : "AND json_extract(input_json, '$.contentVersion') = ?"} ORDER BY created_at DESC, id DESC LIMIT 1`).get(contentId, task, ...(version === undefined ? [] : [version]));
  return app.context.jobs.get(z.object({ id: z.uuid() }).parse(raw).id)!;
}
function finish(app: T02cTestApp, jobId: string, value: unknown, loseFinished = false, existingFence?: WorkerFence) {
  const job = app.context.jobs.get(jobId)!;
  if (job.input.jobType !== "composition_provider") throw new Error("expected composition job");
  const fence = existingFence ?? app.context.jobs.assign(jobId, "fixture-worker").grant.fence;
  const requestHash = `rh1:${sha256(stableJson(job.input.requestEnvelope))}`;
  const permit = app.context.providerJournal.intent(fence, { schemaVersion: 1, type: "call_intent", messageId: randomUUID(), fence,
    purpose: job.input.task === "intent" || job.input.task === "recommend" ? "planning" : "generation", callOrdinal: 0, requestHash, requestEnvelope: job.input.requestEnvelope });
  const rawResponse = JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] });
  const accepted = app.context.providerJournal.result(fence, { schemaVersion: 1, type: "call_result", messageId: randomUUID(), fence,
    attemptId: permit.attemptId, logicalCallId: permit.logicalCallId, requestHash, responseHash: `resp1:${sha256(rawResponse)}`, rawResponse, providerRequestId: null, cost: null });
  expect(accepted.effective).toBe(true);
  if (!loseFinished) app.context.jobs.finish({ fence, state: "succeeded", result: app.context.providerJournal.compositionResult(jobId), error: null });
  return fence;
}
function intent(merchantId: string) { return { title: "库存核对", purpose: "说明库存核对步骤", audience: "店长", constraints: [], merchantId, searchTerms: ["库存"], gaps: [] }; }
async function propose(f: Awaited<ReturnType<typeof fixture>>, contentId: string, version: number) {
  const job = latest(f.app, contentId, "intent", version);
  finish(f.app, job.snapshot.id, intent(f.merchantId));
  await f.app.context.composer.advance(contentId);
  const recommendation = latest(f.app, contentId, "recommend", version);
  const candidates = candidatePayload(recommendation);
  const evidenceIds = candidates.evidence.map((item) => item.evidenceId);
  finish(f.app, recommendation.snapshot.id, { kind: "feishu_doc", title: "库存核对方案", templateVersionId: f.template.manifest.templateVersionId,
    reason: "适合按步骤说明", evidenceIds, gaps: [], sections: [{ key: "steps", heading: "库存步骤", intent: "说明具体步骤", templateContainerKey: "steps", placements: evidenceIds.map((evidenceId) => ({ evidenceId, purpose: "支持步骤", position: "正文", use: "support" })) }] });
  await f.app.context.composer.advance(contentId);
  const result = await f.app.context.composer.read(contentId);
  expect(result.state, JSON.stringify(result)).toBe("proposed");
  if (result.state !== "proposed") throw new Error("expected proposal");
  return result.proposal;
}
function candidatePayload(job: ReturnType<typeof latest>) {
  if (job.input.jobType !== "composition_provider") throw new Error("job type");
  return z.object({ payload: z.object({ candidates: z.object({ evidence: z.array(z.object({ evidenceId: z.uuid(), kind: z.string(), sourceVersionId: z.string().optional() })) }) }) }).parse(JSON.parse(job.input.requestEnvelope.messages[1]!.content)).payload.candidates;
}
async function confirm(app: T02cTestApp, proposal: Proposal, key = randomUUID()) {
  return app.rawJson("POST", "/api/v1/compositions/confirm", { proposalId: proposal.id, proposalHash: proposal.hash }, key);
}
function draft(proposal: Proposal) {
  return { kind: "feishu_doc", title: proposal.title, sections: [{ key: "steps", heading: "库存步骤", parts: [{ key: "body", kind: "paragraph", text: "先检查库存，再按缺口补货。", sources: proposal.evidence.filter((item) => item.kind === "source").map((item) => item.id) }] }] };
}
function count(app: T02cTestApp, table: string) { return z.object({ n: z.number() }).parse(app.context.database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n; }

describe("Composer API and durable continuation", () => {
  it("plans through frozen real keyword candidates, replays submit and keeps GET read-only", async () => {
    const f = await fixture();
    const key = randomUUID();
    const initial = await submit(f.app, key);
    const replay = await submit(f.app, key);
    expect(replay).toEqual(initial);
    const proposal = await propose(f, initial.contentId, initial.version);
    expect(proposal.evidence.some((item) => item.kind === "source" && item.sourceLabel.includes(f.sourceVersionId))).toBe(true);
    expect(count(f.app, "provider_calls")).toBe(2);
    expect(count(f.app, "revisions")).toBe(1);
    expect(count(f.app, "exports")).toBe(0);
    const before = count(f.app, "jobs");
    for (let i = 0; i < 3; i++) expect(view(await f.app.getJson(`/api/v1/compositions/${initial.contentId}`)).state).toBe("proposed");
    expect(count(f.app, "jobs")).toBe(before);
  });

  it("adjusts once with CAS, accumulates instructions and excludes old evidence even through new search handles", async () => {
    const f = await fixture();
    const initial = await submit(f.app);
    const old = await propose(f, initial.contentId, initial.version);
    const source = old.evidence.find((item) => item.kind === "source")!;
    const key = randomUUID();
    const request = { mode: "adjust", contentId: initial.contentId, expectedVersion: initial.version, instruction: "减少背景", choices: { selection: { includeHandles: [], excludeEvidenceIds: [source.id] } } };
    const changed = await f.app.rawJson("POST", "/api/v1/compositions/submit", request, key);
    expect(changed.status, JSON.stringify(changed.body)).toBe(202);
    expect((await f.app.rawJson("POST", "/api/v1/compositions/submit", request, key)).body).toEqual(changed.body);
    expect((await f.app.rawJson("POST", "/api/v1/compositions/submit", { ...request, instruction: "另一窗口" })).status).toBe(409);
    expect((await confirm(f.app, old)).status).toBe(409);
    const current = await propose(f, initial.contentId, view(changed.body).version);
    expect(current.evidence.some((item) => item.kind === "source")).toBe(false);
    const job = latest(f.app, initial.contentId, "intent", current.basedOnVersion);
    expect(JSON.stringify(job.input)).toContain("减少背景");
    expect(JSON.stringify(job.input)).toContain("给店长说明库存核对");
    expect(count(f.app, "authoring_proposals")).toBe(2);
    expect(count(f.app, "revisions")).toBe(1);
  });

  it("does not let a late old planning response become the current proposal", async () => {
    const f = await fixture();
    const initial = await submit(f.app);
    const oldJob = latest(f.app, initial.contentId, "intent", initial.version);
    const changed = await f.app.rawJson("POST", "/api/v1/compositions/submit", { mode: "adjust", contentId: initial.contentId, expectedVersion: initial.version, instruction: "先说明操作" });
    expect(changed.status).toBe(202);
    finish(f.app, oldJob.snapshot.id, intent(f.merchantId));
    await f.app.context.composer.advance(initial.contentId);
    expect(count(f.app, "authoring_proposals")).toBe(0);
    expect(f.app.context.database.db.prepare("SELECT id FROM jobs WHERE business_key = ?").get(`composition:recommend:${oldJob.snapshot.id}`)).toBeUndefined();
    const current = await propose(f, initial.contentId, view(changed.body).version);
    expect(current.basedOnVersion).toBe(initial.version + 1);
  });

  it("confirms once across different command keys and expired HTTP receipts, then accepts one whole revision", async () => {
    const f = await fixture();
    const initial = await submit(f.app);
    const proposal = await propose(f, initial.contentId, initial.version);
    const first = await confirm(f.app, proposal);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    f.app.context.database.db.prepare("DELETE FROM idempotency_keys").run();
    const repeated = await confirm(f.app, proposal);
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(202);
    expect(view(first.body).state).toBe("working");
    expect(count(f.app, "authoring_confirmations")).toBe(1);
    expect(count(f.app, "generation_inputs")).toBe(1);
    const write = latest(f.app, initial.contentId, "write_doc");
    finish(f.app, write.snapshot.id, draft(proposal));
    await f.app.context.composer.advance(initial.contentId);
    await f.app.context.composer.advance(initial.contentId);
    const db = f.app.context.database.db;
    const accepted = db.prepare("SELECT created_by, ast_json, reason FROM revisions WHERE created_by = 'ai_accepted'").all();
    expect(accepted, JSON.stringify(await f.app.context.composer.read(initial.contentId))).toHaveLength(1);
    expect(count(f.app, "ai_candidates")).toBe(1);
    expect(JSON.stringify(accepted)).toContain("先检查库存");
    expect(JSON.stringify(accepted)).toContain("自动接收全文");
    expect(db.prepare("SELECT receipt_key FROM worker_receipts WHERE job_id = ? AND receipt_key = 'composition:delivery'").get(write.snapshot.id)).toBeDefined();
    expect((await f.app.rawJson("POST", "/api/v1/compositions/submit", { mode: "adjust", contentId: initial.contentId, expectedVersion: 1, instruction: "改稿" })).status).toBe(409);
  });

  it("recovers saved completed payload without finished and does not resend unknown calls", async () => {
    const f = await fixture();
    const initial = await submit(f.app);
    const job = latest(f.app, initial.contentId, "intent");
    finish(f.app, job.snapshot.id, intent(f.merchantId), true);
    f.app.context.jobs.requeueAfterWorkerExit(job.snapshot.id);
    await f.app.context.composer.advance(initial.contentId);
    expect(f.app.context.jobs.snapshotById(job.snapshot.id).state).toBe("succeeded");
    expect(count(f.app, "provider_calls")).toBe(1);
    const recommend = latest(f.app, initial.contentId, "recommend");
    const grant = f.app.context.jobs.assign(recommend.snapshot.id, "lost-worker").grant;
    if (grant.input.jobType !== "composition_provider") throw new Error("job type");
    f.app.context.providerJournal.intent(grant.fence, { schemaVersion: 1, type: "call_intent", messageId: randomUUID(), fence: grant.fence, purpose: "planning", callOrdinal: 0,
      requestHash: `rh1:${sha256(stableJson(grant.input.requestEnvelope))}`, requestEnvelope: grant.input.requestEnvelope });
    f.app.context.jobs.requeueAfterWorkerExit(recommend.snapshot.id);
    await f.app.context.composer.advance(initial.contentId);
    expect(f.app.context.jobs.snapshotById(recommend.snapshot.id).state).toBe("waiting_input");
    expect(count(f.app, "provider_calls")).toBe(2);
    expect((await f.app.context.composer.read(initial.contentId)).state).toBe("blocked");
  });

  it("runs real worker IPC through two AI rounds, whole deck acceptance and registered HTML without browser advancement", async () => {
    const f = await fixture("html_deck");
    let calls = 0;
    let activeApp = f.app;
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requestBody = z.object({ messages: z.array(z.object({ content: z.string() })) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
      const input = z.object({ payload: z.record(z.string(), z.unknown()) }).parse(JSON.parse(requestBody.messages[1]!.content)).payload;
      let result: unknown;
      calls++;
      if ("candidates" in input) {
        const candidates = z.object({ evidence: z.array(z.object({ evidenceId: z.uuid() })) }).parse(input.candidates);
        result = { kind: "html_deck", title: "库存核对方案", templateVersionId: f.template.manifest.templateVersionId, reason: "适合操作培训",
          evidenceIds: candidates.evidence.map((item) => item.evidenceId), gaps: [], slides: [{ key: "steps", title: "库存步骤", intent: "说明操作",
            templateContainerKey: "steps", layoutKey: "title-body-media", placements: [] }] };
      } else if ("proposal" in input) {
        const proposal = z.object({ title: z.string(), evidence: z.array(z.object({ id: z.uuid(), kind: z.string() })) }).parse(input.proposal);
        result = { kind: "html_deck", title: proposal.title, slides: [{ key: "steps", title: "库存步骤", speakerNotes: "请门店按步骤核对",
          templateContainerKey: "steps", layoutKey: "title-body-media", parts: [{ key: "body", kind: "paragraph", templateSlotKey: "steps-body", text: "先检查库存，再按缺口补货。",
            sources: proposal.evidence.filter((item) => item.kind === "source").map((item) => item.id) }] }] };
      } else result = intent(f.merchantId);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("provider port");
    f.app.context.database.db.prepare("UPDATE provider_configs SET base_url = ?").run(`http://127.0.0.1:${address.port}/v1`);
    process.env.COMPOSER_TEST_KEY = "fixture-only";
    try {
      await f.app.context.scheduler.start();
      const initialResponse = await f.app.rawJson("POST", "/api/v1/compositions/submit", { mode: "create", idea: "给店长说明库存核对", delivery: { kind: "html_deck" } });
      expect(initialResponse.status, JSON.stringify(initialResponse.body)).toBe(202);
      const initial = view(initialResponse.body);
      await until(() => count(f.app, "authoring_proposals") === 1);
      const proposal = f.app.context.plans.currentProposal(initial.contentId, initial.version)!;
      expect((await confirm(f.app, proposal)).status).toBe(202);
      await until(() => count(f.app, "export_artifacts") === 1);
      const result = await f.app.context.composer.read(initial.contentId);
      expect(result.state, JSON.stringify(result)).toBe("delivered");
      expect(calls).toBe(3);
      expect(count(f.app, "authoring_confirmations")).toBe(1);
      expect(count(f.app, "ai_candidates")).toBe(1);
      expect(count(f.app, "exports")).toBe(1);
      if (result.state !== "delivered" || result.result.kind !== "html_deck") throw new Error("deck delivery");
      const preview = await fetch(`${f.app.base}${result.result.previewUrl}`, { headers: { cookie: f.app.cookie } });
      expect(preview.status).toBe(200);
      expect(await preview.text()).toContain("先检查库存");
      const exportId = result.result.exportId;
      const output = f.app.context.outputs.get(exportId);
      const db = f.app.context.database.db;
      expect(db.prepare("SELECT receipt_key FROM worker_receipts WHERE job_id = ? AND receipt_key LIKE 'output:completion:%'").all(output.jobId)).toHaveLength(1);
      await f.app.context.scheduler.close();
      db.transaction(() => {
        db.prepare("DELETE FROM export_artifacts WHERE export_id = ?").run(exportId);
        db.prepare("UPDATE exports SET status = 'queued', output_blob_hash = NULL WHERE id = ?").run(exportId);
        db.prepare("UPDATE jobs SET state = 'running', result_json = NULL, lease_until = ?, lease_owner = 'interrupted-output' WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), output.jobId);
      })();
      await f.app.close();
      apps.splice(apps.indexOf(f.app), 1);
      activeApp = await startT02cApp(f.app.config.dataRoot);
      apps.push(activeApp);
      await activeApp.context.scheduler.start();
      await until(() => count(activeApp, "export_artifacts") === 1);
      const restored = await activeApp.context.composer.read(initial.contentId);
      expect(restored.state, JSON.stringify(restored)).toBe("delivered");
      if (restored.state === "delivered") expect(restored.result.exportId).toBe(exportId);
      expect(activeApp.context.jobs.snapshotById(output.jobId).attempt).toBe(1);
      expect(calls).toBe(3);

    } finally {
      await activeApp.context.scheduler.close();
      delete process.env.COMPOSER_TEST_KEY;
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 20000);

  it("resumes the same failed or waiting output with exhausted attempts and intact checkpoint", async () => {
    const f = await fixture();
    vi.spyOn(f.app.context.outputs, "hasFeishuCredential").mockReturnValue(true);
    const initial = await submit(f.app);
    const proposal = await propose(f, initial.contentId, initial.version);
    expect((await confirm(f.app, proposal)).status).toBe(202);
    const write = latest(f.app, initial.contentId, "write_doc");
    finish(f.app, write.snapshot.id, draft(proposal));
    await f.app.context.composer.advance(initial.contentId);
    const fixed = f.app.context.plans.composition(initial.contentId)!;
    const output = f.app.context.jobs.findBusinessKey(`composition:delivery:${fixed.confirmationId}`)!;
    const grant = f.app.context.jobs.assign(output.snapshot.id, "output-fixture").grant;
    const checkpoint = { schemaVersion: 1 as const, jobType: "feishu_publish" as const, phase: "media_uploaded" as const,
      documentId: "original-document", documentUrl: "https://example.test/original-document", batchIndex: 2,
      blockMap: { original: "remote-block" }, mediaMap: { original: "remote-media" }, pendingTableCells: ["remaining-cell"] };
    expect(f.app.context.jobs.checkpoint(grant.fence, checkpoint)).toBe(true);
    f.app.context.jobs.finish({ fence: grant.fence, state: "failed", result: null, error: { code: "FEISHU_AUTH_MISSING", message: "fixture auth expired", retryable: false } });
    const db = f.app.context.database.db;
    db.prepare("UPDATE jobs SET max_attempts = attempt WHERE id = ?").run(output.snapshot.id);
    expect(() => f.app.context.jobs.prepareRetry(output.snapshot.id)).toThrow();
    const blocked = await f.app.rawJson("POST", `/api/v1/jobs/${output.snapshot.id}/resume`, {});
    expect(blocked.status).toBe(409);
    const recovered = f.app.context.jobs.resumeOutput(output.snapshot.id);
    expect(recovered.checkpoint).toEqual(checkpoint);
    expect(recovered.maxAttempts).toBe(recovered.attempt + 1);
    const next = f.app.context.jobs.assign(output.snapshot.id, "resumed-fixture").grant;
    expect(next.checkpoint).toEqual(checkpoint);
    f.app.context.jobs.waitForInput(next.fence, checkpoint, "FEISHU_AUTH_MISSING", "fixture waiting");
    db.prepare("UPDATE jobs SET max_attempts = attempt WHERE id = ?").run(output.snapshot.id);
    const waiting = f.app.context.jobs.resume(output.snapshot.id).snapshot;
    expect(waiting.checkpoint).toEqual(checkpoint);
    expect(waiting.maxAttempts).toBe(waiting.attempt + 1);
  });

  it("startup consumes an already saved model response after reopening the database", async () => {
    const f = await fixture();
    const initial = await submit(f.app);
    const job = latest(f.app, initial.contentId, "intent");
    finish(f.app, job.snapshot.id, intent(f.merchantId), true);
    await f.app.close();
    apps.splice(apps.indexOf(f.app), 1);
    const restarted = await startT02cApp(f.app.config.dataRoot);
    apps.push(restarted);
    await restarted.context.scheduler.start();
    await until(() => restarted.context.jobs.findBusinessKey(`composition:recommend:${job.snapshot.id}`) !== null);
    expect(restarted.context.jobs.snapshotById(job.snapshot.id).state).toBe("succeeded");
    expect(count(restarted, "provider_calls")).toBe(1);
    expect(count(restarted, "jobs")).toBe(2);
  });

  it("never overwrites a baseline changed after confirmation", async () => {
    const f = await fixture();
    const initial = await submit(f.app);
    const proposal = await propose(f, initial.contentId, initial.version);
    expect((await confirm(f.app, proposal)).status).toBe(202);
    const fixed = f.app.context.plans.composition(initial.contentId)!;
    const base = f.app.context.generationInputs.require(latest(f.app, initial.contentId, "write_doc").input.inputId!);
    f.app.context.database.db.transaction(() => commitRevision(f.app.context.database.db, { mode: "manual", renditionId: fixed.renditionId,
      baseRevisionId: fixed.emptyBaseRevisionId, expectedCurrentRevisionId: fixed.emptyBaseRevisionId,
      operations: [{ op: "setField", nodeId: base.rootNodeId, path: "title", value: "已被内部修改" }], evidenceSelections: [],
      createdBy: "user", reason: "测试基线改变", claims: [], fixedEvidence: [] }))();
    const write = latest(f.app, initial.contentId, "write_doc");
    finish(f.app, write.snapshot.id, draft(proposal));
    await f.app.context.composer.advance(initial.contentId);
    expect(count(f.app, "ai_candidates")).toBe(0);
    expect(f.app.context.database.db.prepare("SELECT id FROM revisions WHERE created_by = 'ai_accepted'").all()).toHaveLength(0);
    expect((await f.app.context.composer.read(initial.contentId)).state).toBe("blocked");
    expect(base.baseRevisionId).toBe(fixed.emptyBaseRevisionId);
  });
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("后台接续超时");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
