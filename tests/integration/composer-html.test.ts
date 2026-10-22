import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BlobStore } from "@dmall/storage";
import { AstSchema, CreateContentRequestSchema, type JobCheckpoint } from "@dmall/contracts";
import { unzipFiles } from "@dmall/renderers";
import { runExportOutputJob, type OutputJobDeps } from "../../apps/worker/src/outputs.js";
import { ContentRepository } from "../../apps/server/src/content-repository.js";
import { IdempotencyRepository } from "../../apps/server/src/idempotency.js";
import { startT02cApp, type T02cTestApp } from "./t02c-test-helpers.js";

const apps: T02cTestApp[] = [];
const temporary: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) { await app.close(); await rm(app.config.dataRoot, { recursive: true, force: true }); }
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function hash(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
const deps: OutputJobDeps = {
  emitCheckpoint(_checkpoint: JobCheckpoint) {}, emitProgress() {},
  async waitForInput() { throw new Error("HTML does not wait for remote input"); },
  async withRemoteOperation(_input, action) { return action(); },
};

async function fixture() {
  const app = await startT02cApp(); apps.push(app);
  const db = app.context.database.db;
  const columns = z.array(z.object({ name: z.string() })).parse(db.prepare("PRAGMA table_info(exports)").all());
  if (!columns.some((column) => column.name === "business_key")) {
    db.exec(`ALTER TABLE exports ADD COLUMN business_key TEXT;
      CREATE UNIQUE INDEX test_composition_export_key ON exports(business_key);
      ALTER TABLE exports ADD COLUMN composition_request_hash TEXT;`);
  }
  const created = new ContentRepository(db, new IdempotencyRepository(db)).create(
    CreateContentRequestSchema.parse({ schemaVersion: 1, kind: "html_deck", title: "夹具库存演示" }),
    { routeScope: "fixture-html", key: randomUUID(), requestHash: hash("html-content"), requestId: randomUUID() },
  );
  const rendition = created.renditions[0]; if (rendition === undefined) throw new Error("missing rendition");
  const stamp = new Date().toISOString();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9XcAAAAASUVORK5CYII=", "base64");
  const blobs = new BlobStore(app.config.dataRoot);
  const image = await blobs.putBytes({ bytes: png, mime: "image/png" });
  db.prepare("INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(image.sha256, image.relativePath, "image/png", image.bytes, stamp);
  const assetId = randomUUID(), assetVersionId = randomUUID(), sourceId = randomUUID(), sourceVersionId = randomUUID(), occurrenceId = randomUUID();
  db.prepare("INSERT INTO sources(id, kind, canonical_key, title, status, created_at, updated_at) VALUES (?, 'markdown', ?, '夹具来源', 'active', ?, ?)").run(sourceId, `fixture:${sourceId}`, stamp, stamp);
  db.prepare("INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(sourceVersionId, sourceId, image.sha256, image.sha256, stamp, stamp);
  db.prepare("INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at) VALUES (?, ?, 'image', ?, ?)").run(assetId, image.sha256, stamp, stamp);
  db.prepare("INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at) VALUES (?, ?, '库存图', '{}', '{}', 0, ?)").run(assetVersionId, assetId, stamp);
  db.prepare(`INSERT INTO occurrences(id, source_version_id, asset_id, locator_json, occurrence_index,
    heading_path, before_text, after_text, media_status, version, created_at, updated_at)
    VALUES (?, ?, ?, '{}', 0, '', '', '', 'available', 0, ?, ?)`)
    .run(occurrenceId, sourceVersionId, assetId, stamp, stamp);
  const ast = AstSchema.parse({ schemaVersion: 1, kind: "html_deck", title: created.title,
    canvas: { width: 1600, height: 900 }, slides: [
      { id: randomUUID(), title: "库存改进", layout: "title-body-media", speakerNotes: "先核对实际库存", blocks: [
        { id: randomUUID(), type: "paragraph", inlines: [{ text: "按周核对库存和补货量", marks: [] }] },
        { id: randomUUID(), type: "list", ordered: true, items: [[{ text: "先盘点", marks: [] }], [{ text: "再补货", marks: [] }]] },
        { id: randomUUID(), type: "table", columns: ["阶段", "操作"], rows: [[[ { text: "本周", marks: [] } ], [{ text: "盘点", marks: [] }]]] },
        { id: randomUUID(), type: "image", assetVersionId, derivativeId: null, occurrenceId, caption: "库存图", alt: "夹具图片", fit: "contain" },
      ] },
      { id: randomUUID(), title: "实施步骤", layout: "closing", speakerNotes: "按周复盘", blocks: [
        { id: randomUUID(), type: "paragraph", inlines: [{ text: "按周复盘", marks: [] }] },
      ] },
    ] });
  const revisionId = randomUUID();
  db.prepare(`INSERT INTO revisions(id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at)
    VALUES (?, ?, ?, NULL, ?, 'user', '输出夹具', ?)`)
    .run(revisionId, rendition.id, rendition.currentRevisionId, JSON.stringify(ast), stamp);
  return { app, ast, image, input: { contentId: created.id, renditionId: rendition.id, revisionId,
    target: { kind: "html_deck" as const }, exportId: randomUUID(), jobId: randomUUID(),
    businessKey: `composition:${created.id}:delivery`, requestHash: hash("html fixture") } };
}

describe("composition HTML delivery", () => {
  it("keeps one permanent delivery and serves the exact rendered ZIP pages and assets online and offline", async () => {
    const fixtureData = await fixture();
    let app = fixtureData.app;
    const input = fixtureData.input;
    let outputs = app.context.outputs;
    const [a, b] = await Promise.all([outputs.createForComposition(input), outputs.createForComposition(input)]);
    expect(a).toEqual({ exportId: input.exportId, jobId: input.jobId }); expect(b).toEqual(a);
    app.context.database.db.prepare("DELETE FROM idempotency_keys").run();
    const dataRoot = app.config.dataRoot;
    await app.close(); apps.splice(apps.indexOf(app), 1);
    app = await startT02cApp(dataRoot); apps.push(app);
    outputs = app.context.outputs;
    await expect(outputs.createForComposition(input)).resolves.toEqual(a);
    await expect(outputs.createForComposition({ ...input, requestHash: hash("changed") })).rejects.toMatchObject({ code: "DELIVERY_IDENTITY_CONFLICT" });
    expect(app.context.database.db.prepare("SELECT COUNT(*) AS n FROM export_jobs").get()).toEqual({ n: 1 });
    const grant = await outputs.prepareGrant(app.context.jobs.assign(a.jobId, "html-fixture").grant);
    const result = await runExportOutputJob(grant, deps);
    expect(result.format).toBe("html_zip");
    expect(outputs.get(a.exportId).artifacts).toEqual([]);
    await outputs.prepareCompletion(a.jobId, result);
    app.context.jobs.finish({ fence: grant.fence, state: "succeeded", result, error: null });
    const record = outputs.get(a.exportId); expect(record.status).toBe("succeeded");
    const artifact = record.artifacts[0]; if (artifact === undefined) throw new Error("missing artifact");
    const download = await fetch(`${app.base}${artifact.downloadUrl}`, { headers: { cookie: app.cookie } });
    expect(download.status).toBe(200);
    const zipBytes = Buffer.from(await download.arrayBuffer());
    expect(hash(zipBytes)).toBe(artifact.sha256);
    const zip = unzipFiles(zipBytes);
    const previewUrl = `${app.base}/api/v1/exports/${a.exportId}/preview/index.html`;
    const preview = await fetch(previewUrl, { headers: { cookie: app.cookie } });
    expect(preview.status).toBe(200); expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(await preview.text()).toBe(Buffer.from(zip["index.html"] ?? []).toString("utf8"));
    const assetPath = Object.keys(zip).find((path) => path.startsWith("assets/") && path.endsWith(".png"));
    if (assetPath === undefined) throw new Error("missing PNG");
    const asset = await fetch(`${app.base}/api/v1/exports/${a.exportId}/preview/${assetPath}`, { headers: { cookie: app.cookie } });
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(Buffer.from(zip[assetPath] ?? []));
    expect(() => outputs.htmlPreviewResource(a.exportId, "../secret")).toThrow();
    expect(() => outputs.htmlPreviewResource(a.exportId, "not-in-manifest.png")).toThrow();
    const offline = await mkdtemp(join(tmpdir(), "composer-offline-")); temporary.push(offline);
    for (const [path, bytes] of Object.entries(zip)) { await mkdir(dirname(join(offline, path)), { recursive: true }); await writeFile(join(offline, path), bytes); }
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const localUrl = new URL(app.base);
      await context.addCookies([{ name: app.cookie.split("=")[0] ?? "", value: app.cookie.split("=").slice(1).join("="), url: localUrl.origin }]);
      const page = await context.newPage();
      await page.goto(previewUrl);
      await expect.poll(() => page.locator("img").evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
      expect(await page.locator(".slide").count()).toBe(2);
      await page.locator("[data-next]").click();
      expect(await page.locator(".slide.is-active").textContent()).toContain("实施步骤");
      await page.locator("[data-prev]").click();
      expect(await page.locator("body").textContent()).toContain("先核对实际库存");
      await context.setOffline(true);
      await page.goto(pathToFileURL(join(offline, "index.html")).href);
      await expect.poll(() => page.locator("img").evaluateAll((images) => images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
      expect(await page.locator(".slide").count()).toBe(2);
      await page.locator("[data-next]").click();
      expect(await page.locator(".slide.is-active").textContent()).toContain("实施步骤");
      await page.locator("[data-prev]").click();
      expect(await page.locator("body").textContent()).toContain("按周核对库存和补货量");
    } finally { await browser.close(); }
    const legacy = await outputs.createExport({ schemaVersion: 1, renditionId: input.renditionId,
      revisionId: input.revisionId, format: "html_zip", options: { speakerNotes: true } }, {
      routeScope: "fixture-legacy-export", key: randomUUID(), requestHash: hash("legacy-export"), requestId: randomUUID(),
    });
    expect(legacy.statusCode).toBe(202);
    const legacyStart = z.object({ data: z.object({ exportId: z.uuid(), jobId: z.uuid() }) }).parse(legacy.response).data;
    const legacyGrant = await outputs.prepareGrant(app.context.jobs.assign(legacyStart.jobId, "legacy-fixture").grant);
    const legacyResult = await runExportOutputJob(legacyGrant, deps);
    await outputs.prepareCompletion(legacyStart.jobId, legacyResult);
    app.context.jobs.finish({ fence: legacyGrant.fence, state: "succeeded", result: legacyResult, error: null });
    expect(outputs.get(legacyStart.exportId).status).toBe("succeeded");
    const artifactPath = outputs.artifactPath(a.exportId, artifact.id).path;
    await writeFile(artifactPath, "corrupt ZIP");
    expect(() => outputs.htmlPreviewResource(a.exportId, "index.html")).toThrow("校验失败");
  });

  it("rejects changed media before rendering or registering a successful output", async () => {
    const { app, input, image } = await fixture();
    await app.context.outputs.createForComposition(input);
    const grant = await app.context.outputs.prepareGrant(app.context.jobs.assign(input.jobId, "media-fixture").grant);
    await writeFile(join(app.config.dataRoot, image.relativePath), "changed source");
    await expect(runExportOutputJob(grant, deps)).rejects.toMatchObject({ code: "EXPORT_MEDIA_MISSING" });
    expect(app.context.outputs.get(input.exportId).artifacts).toEqual([]);
  });
});
