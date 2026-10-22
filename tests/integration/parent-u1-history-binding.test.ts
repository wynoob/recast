import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RevisionRecordSchema,
  RevisionListSchema,
  RevisionViewSchema,
} from "@dmall/contracts";
import { startT02cApp, type T02cTestApp } from "./t02c-test-helpers.js";

const apps: T02cTestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => {
    const dataRoot = app.config.dataRoot;
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }));
});

describe("parent historical binding regression", () => {
  it("preserves inherited occurrence binding when only content title changes", async () => {
    const app = await appFixture();
    const created = await createContent(app, "素材闭包");
    const rendition = requireRendition(created);
    const fixture = seedMediaFixture(app);
    const sectionId = randomUUID();
    const blockId = randomUUID();
    const response = await app.rawJson("POST", `/api/v1/renditions/${rendition.id}/revisions`, {
      schemaVersion: 1,
      baseRevisionId: rendition.currentRevisionId,
      operations: [{
        op: "insertNode",
        parentId: rendition.rootNodeId,
        afterId: null,
        node: {
          id: sectionId,
          title: "图片",
          locks: [],
          blocks: [{
            id: blockId,
            type: "image",
            assetVersionId: fixture.assetVersionId,
            derivativeId: fixture.derivativeId,
            occurrenceId: fixture.occurrenceId,
            caption: "图",
            alt: "图",
            fit: "contain",
            provenance: [],
            locks: [],
          }],
        },
      }],
      claims: [],
      evidenceSelections: [],
    });
    expect(response.status).toBe(201);
    const view = jsonData(response.body, RevisionViewSchema);
    expect(view.evidence.kind).toBe("resolved");
    if (view.evidence.kind !== "resolved") throw new Error("resolved evidence expected");
    expect(view.evidence.evidence.directRefs.map((ref) => ref.refType).sort()).toEqual([
      "asset_version",
      "derivative",
      "occurrence",
    ]);
    expect(view.evidence.evidence.transitiveRefs).toEqual(expect.arrayContaining([
      { refType: "source_version", refId: fixture.sourceVersionId },
    ]));
    expect(view.evidence.evidence.blobHashes.sort()).toEqual([
      fixture.assetBlobHash,
      fixture.derivativeBlobHash,
      fixture.sourceBlobHash,
    ].sort());
    expect(view.evidence.evidence.bindings).toEqual([expect.objectContaining({
      requestedOccurrenceId: fixture.occurrenceId,
      canonicalOccurrenceId: fixture.occurrenceId,
      sourceVersionId: fixture.sourceVersionId,
      assetIdAtCapture: fixture.assetId,
    })]);
    expect(view.references.every((item) => item.state.kind === "available")).toBe(true);
    expect(count(app, "revision_refs", "revision_id", view.id)).toBe(3);
    app.context.database.db.prepare("UPDATE occurrences SET version = version + 1 WHERE id = ?").run(fixture.occurrenceId);
    const next = await saveTitle(app, { ...rendition, currentRevisionId: view.id }, "仅修改稿件标题");
    expect(next.evidence.kind).toBe("resolved");
    if (next.evidence.kind !== "resolved") throw new Error("resolved evidence expected");
    expect(next.evidence.evidence.bindings).toEqual(view.evidence.evidence.bindings);

  });


});
async function appFixture(): Promise<T02cTestApp> {
  const app = await startT02cApp();
  apps.push(app);
  return app;
}

type ContentResponse = {
  id: string;
  title: string;
  renditions: Array<{
    id: string;
    rootNodeId: string;
    currentRevisionId: string;
    revision: unknown;
  }>;
};

function requireRendition(content: ContentResponse): NonNullable<ContentResponse["renditions"][number]> {
  const rendition = content.renditions[0];
  if (rendition === undefined) throw new Error("rendition missing");
  return rendition;
}

async function createContent(app: T02cTestApp, title: string): Promise<ContentResponse> {
  const response = await app.rawJson("POST", "/api/v1/contents", {
    schemaVersion: 1,
    title,
    kind: "feishu_doc",
  });
  expect(response.status).toBe(201);
  return (response.body as { data: ContentResponse }).data;
}

async function saveTitle(
  app: T02cTestApp,
  rendition: ReturnType<typeof requireRendition>,
  title: string,
) {
  const response = await app.rawJson("POST", `/api/v1/renditions/${rendition.id}/revisions`, {
    schemaVersion: 1,
    baseRevisionId: rendition.currentRevisionId,
    operations: [{
      op: "setField",
      nodeId: rendition.rootNodeId,
      path: "title",
      value: title,
    }],
    claims: [],
    evidenceSelections: [],
  });
  expect(response.status).toBe(201);
  return jsonData(response.body, RevisionViewSchema);
}

function jsonData<T>(body: unknown, schema: { parse(value: unknown): T }): T {
  const envelope = body as { data: unknown };
  return schema.parse(envelope.data);
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function count(app: T02cTestApp, table: string, column: string, value: string): number {
  return (app.context.database.db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
  ).get(value) as { count: number }).count;
}

function seedMediaFixture(app: T02cTestApp): {
  assetId: string;
  assetVersionId: string;
  derivativeId: string;
  occurrenceId: string;
  sourceVersionId: string;
  assetBlobHash: string;
  derivativeBlobHash: string;
  sourceBlobHash: string;
} {
  const db = app.context.database.db;
  const now = new Date().toISOString();
  const sourceId = randomUUID();
  const sourceVersionId = randomUUID();
  const assetId = randomUUID();
  const assetVersionId = randomUUID();
  const derivativeId = randomUUID();
  const occurrenceId = randomUUID();
  const sourceBlob = "1".repeat(64);
  const assetBlob = "2".repeat(64);
  const derivativeBlob = "3".repeat(64);
  db.prepare(
    "INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, 'application/octet-stream', 1, ?)",
  ).run(sourceBlob, `blobs/${sourceBlob}`, now);
  db.prepare(
    "INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, 'image/png', 1, ?)",
  ).run(assetBlob, `blobs/${assetBlob}`, now);
  db.prepare(
    "INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, 'image/png', 1, ?)",
  ).run(derivativeBlob, `blobs/${derivativeBlob}`, now);
  db.prepare(
    "INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at) VALUES (?, 'markdown', ?, '来源', NULL, 'active', ?, ?)",
  ).run(sourceId, `source:${sourceId}`, now, now);
  db.prepare(
    "INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
  ).run(sourceVersionId, sourceId, "a".repeat(64), sourceBlob, now, now);
  db.prepare(
    "INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at) VALUES (?, ?, 'image', ?, ?)",
  ).run(assetId, assetBlob, now, now);
  db.prepare(
    "INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at) VALUES (?, ?, '图', '{}', '{}', 0, ?)",
  ).run(assetVersionId, assetId, now);
  db.prepare(
    `INSERT INTO derivatives(id, asset_id, kind, recipe_json, recipe_hash, blob_hash, status, created_at)
     VALUES (?, ?, 'preview', '{}', ?, ?, 'available', ?)`,
  ).run(derivativeId, assetId, "b".repeat(64), derivativeBlob, now);
  db.prepare(
    `INSERT INTO occurrences(
       id, source_version_id, asset_id, locator_json, occurrence_index,
       heading_path, before_text, after_text, media_status, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, '', '', '', 'available', 3, ?, ?)`,
  ).run(
    occurrenceId,
    sourceVersionId,
    assetId,
    JSON.stringify({ schemaVersion: 1, kind: "markdown", line: 1, column: 1, ordinal: 0, rawTarget: "img.png", normalizedRelativePath: "img.png", resolution: "inside_root" }),
    now,
    now,
  );
  return {
    assetId,
    assetVersionId,
    derivativeId,
    occurrenceId,
    sourceVersionId,
    assetBlobHash: assetBlob,
    derivativeBlobHash: derivativeBlob,
    sourceBlobHash: sourceBlob,
  };
}

async function productionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await productionFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

