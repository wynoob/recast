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
import {
  createInternalContent,
  restoreInternalRevision,
  saveInternalRevision,
} from "./internal-authoring-helpers.js";

const apps: T02cTestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => {
    const dataRoot = app.config.dataRoot;
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }));
});

describe("T06 local manual revisions", () => {
  it("creates a blank content through commitRevision with a complete empty receipt", async () => {
    const app = await appFixture();
    const created = await createContent(app, "空白保存");
    const record = RevisionRecordSchema.parse(created.renditions[0]?.revision);
    const detail = await app.getJson(
      `/api/v1/renditions/${requireRendition(created).id}/revisions?revisionId=${record.id}`,
    );
    const revision = jsonData(detail, RevisionViewSchema);
    expect(revision.evidence.kind).toBe("empty");
    expect(revision.references).toEqual([]);
    expect(revision.parentId).toBeNull();
    const raw = app.context.database.db.prepare(
      "SELECT COUNT(*) AS count FROM revision_evidence WHERE revision_id = ?",
    ).get(revision.id);
    expect(raw).toEqual({ count: 1 });
  });

  it("saves, replays, rejects a different body, and reads typed history", async () => {
    const app = await appFixture();
    const created = await createContent(app, "人工修订");
    const rendition = requireRendition(created);
    const sectionId = randomUUID();
    const body = {
      schemaVersion: 1,
      baseRevisionId: rendition.currentRevisionId,
      operations: [{
        op: "insertNode",
        parentId: rendition.rootNodeId,
        afterId: null,
        node: {
          id: sectionId,
          title: "第一章",
          locks: [],
          blocks: [],
        },
      }],
      claims: [],
      evidenceSelections: [],
    };
    const key = randomUUID();
    const first = await saveInternalRevision(app, rendition.id, body, key);
    expect(first.status).toBe(201);
    const saved = jsonData(first.body, RevisionViewSchema);
    expect(saved.parentId).toBe(rendition.currentRevisionId);
    if (saved.ast.kind !== "feishu_doc") throw new Error("doc expected");
    expect(saved.ast.sections[0]?.id).toBe(sectionId);

    const replay = await saveInternalRevision(app, rendition.id, body, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);

    const different = await saveInternalRevision(
      app,
      rendition.id,
      {
        ...body,
        operations: [{ op: "setField", nodeId: rendition.rootNodeId, path: "title", value: "不同请求" }],
      },
      key,
    );
    expect(different.status).toBe(409);
    expect(errorCode(different.body)).toBe("IDEMPOTENCY_CONFLICT");

    const listBody = await app.getJson(`/api/v1/renditions/${rendition.id}/revisions?limit=20`);
    const list = jsonData(listBody, RevisionListSchema);
    expect(list.total).toBe(2);
    expect(list.items[0]?.id).toBe(saved.id);
    expect(list.nextCursor).toBeNull();

    const detailBody = await app.getJson(
      `/api/v1/renditions/${rendition.id}/revisions?revisionId=${saved.id}`,
    );
    expect(jsonData(detailBody, RevisionViewSchema).id).toBe(saved.id);
  });

  it("lets one of two clients win the same base and leaves exactly one revision", async () => {
    const app = await appFixture();
    const created = await createContent(app, "并发保存");
    const rendition = requireRendition(created);
    const baseRevisionId = rendition.currentRevisionId;
    const operation = (title: string) => ({
      schemaVersion: 1,
      baseRevisionId,
      operations: [{
        op: "setField",
        nodeId: rendition.rootNodeId,
        path: "title",
        value: title,
      }],
      claims: [],
      evidenceSelections: [],
    });
    const [left, right] = await Promise.all([
      saveInternalRevision(app, rendition.id, operation("左"), randomUUID()),
      saveInternalRevision(app, rendition.id, operation("右"), randomUUID()),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    const failed = left.status === 409 ? left : right;
    expect(errorCode(failed.body)).toBe("REVISION_CONFLICT");
    const conflict = failed.body as {
      error: { details: { currentRevision: unknown } };
    };
    const current = RevisionViewSchema.parse(conflict.error.details.currentRevision);
    expect(current.renditionId).toBe(rendition.id);
    expect(count(app, "revisions", "rendition_id", rendition.id)).toBe(2);
  });

  it("restores history as a new revision and rejects a historical revision from another rendition", async () => {
    const app = await appFixture();
    const firstContent = await createContent(app, "主稿");
    const firstRendition = requireRendition(firstContent);
    const firstRevisionId = firstRendition.currentRevisionId;
    const saved = await saveTitle(app, firstRendition, "第二版");

    const secondContent = await createContent(app, "另一个稿件");
    const secondRendition = requireRendition(secondContent);
    const wrong = await restoreInternalRevision(app, secondRendition.id, {
      schemaVersion: 1,
      historicalRevisionId: firstRevisionId,
      expectedRevisionId: secondRendition.currentRevisionId,
    });
    expect(wrong.status).toBe(422);
    expect(errorCode(wrong.body)).toBe("VALIDATION_ERROR");
    expect(count(app, "revisions", "rendition_id", secondRendition.id)).toBe(1);

    const restored = await restoreInternalRevision(app, firstRendition.id, {
      schemaVersion: 1,
      historicalRevisionId: firstRevisionId,
      expectedRevisionId: saved.id,
    });
    expect(restored.status).toBe(201);
    const view = jsonData(restored.body, RevisionViewSchema);
    expect(view.id).not.toBe(firstRevisionId);
    expect(view.parentId).toBe(saved.id);
    expect(view.createdBy).toBe("restore");
    expect(view.ast.kind).toBe("feishu_doc");
    expect(view.ast.title).toBe(firstContent.title);
    expect(count(app, "revisions", "rendition_id", firstRendition.id)).toBe(3);
    const current = app.context.database.db.prepare(
      "SELECT current_revision_id FROM renditions WHERE id = ?",
    ).get(firstRendition.id);
    expect(current).toEqual({ current_revision_id: view.id });
  });

  it("restores a provably empty historical revision without fabricating bindings", async () => {
    const app = await appFixture();
    const created = await createContent(app, "旧空稿");
    const rendition = requireRendition(created);
    const historicalId = randomUUID();
    const now = new Date().toISOString();
    app.context.database.db.prepare(
      "INSERT INTO revisions(id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at) VALUES (?, ?, NULL, NULL, ?, 'user', '迁移前空稿', ?)",
    ).run(
      historicalId,
      rendition.id,
      JSON.stringify({
        schemaVersion: 1,
        kind: "feishu_doc",
        title: "旧空稿",
        locks: [],
        sections: [],
        speakerNotes: {},
      }),
      now,
    );
    const response = await restoreInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      historicalRevisionId: historicalId,
      expectedRevisionId: rendition.currentRevisionId,
    });
    expect(response.status).toBe(201);
    const view = jsonData(response.body, RevisionViewSchema);
    expect(view.evidence.kind).toBe("empty");
    expect(view.evidence.kind === "empty" ? view.evidence.evidence.bindings : null).toEqual([]);
  });

  it("refuses to restore non-empty history without a fixed closure", async () => {
    const app = await appFixture();
    const created = await createContent(app, "历史证据缺失");
    const rendition = requireRendition(created);
    const historicalId = randomUUID();
    const now = new Date().toISOString();
    app.context.database.db.prepare(
      "INSERT INTO revisions(id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at) VALUES (?, ?, NULL, NULL, ?, 'user', '旧非空稿', ?)",
    ).run(
      historicalId,
      rendition.id,
      JSON.stringify({
        schemaVersion: 1,
        kind: "feishu_doc",
        title: "旧非空稿",
        locks: [],
        sections: [{
          id: randomUUID(),
          title: "章节",
          locks: [],
          blocks: [{
            id: randomUUID(),
            type: "image",
            assetVersionId: randomUUID(),
            derivativeId: null,
            occurrenceId: randomUUID(),
            caption: "",
            alt: "",
            fit: "contain",
            provenance: [],
            locks: [],
          }],
        }],
        speakerNotes: {},
      }),
      now,
    );
    const before = count(app, "revisions", "rendition_id", rendition.id);
    const response = await restoreInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      historicalRevisionId: historicalId,
      expectedRevisionId: rendition.currentRevisionId,
    });
    expect(response.status).toBe(422);
    expect(errorCode(response.body)).toBe("REFERENCE_HISTORY_UNRESOLVED");
    expect(count(app, "revisions", "rendition_id", rendition.id)).toBe(before);
  });

  it("does not restore over a current lock", async () => {
    const app = await appFixture();
    const created = await createContent(app, "当前锁");
    const rendition = requireRendition(created);
    const firstRevisionId = rendition.currentRevisionId;
    const sectionId = randomUUID();
    const inserted = await saveInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      baseRevisionId: firstRevisionId,
      operations: [{
        op: "insertNode",
        parentId: rendition.rootNodeId,
        afterId: null,
        node: { id: sectionId, title: "锁定章节", locks: [], blocks: [] },
      }],
      claims: [],
      evidenceSelections: [],
    });
    expect(inserted.status).toBe(201);
    const insertedView = jsonData(inserted.body, RevisionViewSchema);
    const locked = await saveInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      baseRevisionId: insertedView.id,
      operations: [{
        op: "setField",
        nodeId: sectionId,
        path: "locks",
        value: ["*"],
      }],
      claims: [],
      evidenceSelections: [],
    });
    expect(locked.status).toBe(201);
    const lockedView = jsonData(locked.body, RevisionViewSchema);
    const rejected = await restoreInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      historicalRevisionId: firstRevisionId,
      expectedRevisionId: lockedView.id,
    });
    expect(rejected.status).toBe(409);
    expect(errorCode(rejected.body)).toBe("LOCKED_FIELD");
    expect(count(app, "revisions", "rendition_id", rendition.id)).toBe(3);
  });

  it("rejects non-empty unresolved claims and broken AST references without writing", async () => {
    const app = await appFixture();
    const created = await createContent(app, "非法引用");
    const rendition = requireRendition(created);
    const before = count(app, "revisions", "rendition_id", rendition.id);
    const claim = await saveInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      baseRevisionId: rendition.currentRevisionId,
      operations: [],
      claims: [{
        kind: "gap",
        nodeId: rendition.rootNodeId,
        question: "尚未有证据",
      }],
      evidenceSelections: [],
    });
    expect(claim.status).toBe(422);
    expect(errorCode(claim.body)).toBe("UNKNOWN_REFERENCE");

    const image = await saveInternalRevision(app, rendition.id, {
      schemaVersion: 1,
      baseRevisionId: rendition.currentRevisionId,
      operations: [{
        op: "insertNode",
        parentId: rendition.rootNodeId,
        afterId: null,
        node: {
          id: randomUUID(),
          title: "引用章",
          locks: [],
          blocks: [{
            id: randomUUID(),
            type: "image",
            assetVersionId: randomUUID(),
            derivativeId: null,
            occurrenceId: randomUUID(),
            caption: "",
            alt: "",
            fit: "contain",
            provenance: [],
            locks: [],
          }],
        },
      }],
      claims: [],
      evidenceSelections: [],
    });
    expect(image.status).toBe(422);
    expect(errorCode(image.body)).toBe("UNKNOWN_REFERENCE");
    expect(count(app, "revisions", "rendition_id", rendition.id)).toBe(before);
  });

  it("persists direct refs, transitive source refs, blob hashes, and immutable occurrence binding", async () => {
    const app = await appFixture();
    const created = await createContent(app, "素材闭包");
    const rendition = requireRendition(created);
    const fixture = seedMediaFixture(app);
    const sectionId = randomUUID();
    const blockId = randomUUID();
    const response = await saveInternalRevision(app, rendition.id, {
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
  });

  it("returns DISK_FULL and rolls back revision/current/receipt writes", async () => {
    const app = await appFixture();
    const created = await createContent(app, "磁盘满");
    const rendition = requireRendition(created);
    const before = count(app, "revisions", "rendition_id", rendition.id);
    const pageCount = Number(app.context.database.db.pragma("page_count", { simple: true }));
    app.context.database.db.pragma(`max_page_count = ${pageCount}`);
    try {
      const response = await saveInternalRevision(app, rendition.id, {
        schemaVersion: 1,
        baseRevisionId: rendition.currentRevisionId,
        operations: [{
          op: "setField",
          nodeId: rendition.rootNodeId,
          path: "title",
          value: "填满".repeat(1_500_000),
        }],
        claims: [],
        evidenceSelections: [],
      }, randomUUID());
      expect(response.status).toBe(507);
      expect(errorCode(response.body)).toBe("DISK_FULL");
    } finally {
      app.context.database.db.pragma("max_page_count = 1073741823");
    }
    expect(count(app, "revisions", "rendition_id", rendition.id)).toBe(before);
    const current = app.context.database.db.prepare(
      "SELECT current_revision_id FROM renditions WHERE id = ?",
    ).get(rendition.id);
    expect(current).toEqual({ current_revision_id: rendition.currentRevisionId });
    expect(app.context.database.db.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_keys WHERE route_scope LIKE '%/revisions'",
    ).get()).toEqual({ count: 0 });
  });

  it("has only one production revisions INSERT", async () => {
    const files = await productionFiles(join(process.cwd(), "apps/server/src"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (/INSERT\s+INTO\s+revisions/iu.test(text)) offenders.push(file);
    }
    expect(offenders.map((file) => file.split("/apps/server/src/")[1])).toEqual([
      "authoring/revision-commit.ts",
    ]);
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
  const response = createInternalContent(app, {
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
  const response = saveInternalRevision(app, rendition.id, {
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

