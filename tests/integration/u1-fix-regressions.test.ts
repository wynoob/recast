import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { ApiSuccessSchema, ContentDetailSchema, RevisionViewSchema, type AuthoringOperation, type RevisionView } from "@dmall/contracts";
import { startT02cApp, type T02cTestApp } from "./t02c-test-helpers.js";
import {
  createInternalContent,
  restoreInternalRevision,
  saveInternalRevision,
} from "./internal-authoring-helpers.js";

const apps: T02cTestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    await rm(app.config.dataRoot, { recursive: true, force: true });
  }
});

async function editor(kind: "feishu_doc" | "html_deck" = "feishu_doc") {
  const app = await startT02cApp(); apps.push(app);
  const created = createInternalContent(app, { schemaVersion: 1, title: "修复回归", kind });
  expect(created.status).toBe(201);
  const content = ApiSuccessSchema(ContentDetailSchema).parse(created.body).data;
  const rendition = content.renditions[0]; if (rendition === undefined) throw new Error("missing rendition");
  let currentId = rendition.currentRevisionId;
  const post = (operations: AuthoringOperation[], key = randomUUID()) => saveInternalRevision(app, rendition.id, {
    schemaVersion: 1, baseRevisionId: currentId, operations, claims: [], evidenceSelections: [],
  }, key);
  const save = async (operations: AuthoringOperation[]) => {
    const response = await post(operations);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const view = ApiSuccessSchema(RevisionViewSchema).parse(response.body).data;
    currentId = view.id; return view;
  };
  const restore = (historyId: string) => restoreInternalRevision(app, rendition.id, {
    schemaVersion: 1, historicalRevisionId: historyId, expectedRevisionId: currentId,
  });
  return { app, rendition, save, post, restore, current: () => currentId };
}

function writes(e: Awaited<ReturnType<typeof editor>>) {
  const db = e.app.context.database.db;
  return {
    current: db.prepare("SELECT current_revision_id, version FROM renditions WHERE id = ?").get(e.rendition.id),
    revisions: db.prepare("SELECT * FROM revisions ORDER BY id").all(),
    refs: db.prepare("SELECT * FROM revision_refs ORDER BY revision_id, ref_type, ref_id").all(),
    evidence: db.prepare("SELECT * FROM revision_evidence ORDER BY revision_id").all(),
    receipts: db.prepare("SELECT * FROM idempotency_keys ORDER BY route_scope, key").all(),
  };
}

function container(kind: "feishu_doc" | "html_deck", id = randomUUID()) {
  const block = { id: randomUUID(), type: "paragraph" as const, inlines: [{ text: "旧正文", marks: [] }], provenance: [], locks: [] };
  return kind === "feishu_doc"
    ? { id, title: "旧标题", blocks: [block], locks: [] }
    : { id, title: "旧标题", layout: "cover" as const, speakerNotes: "旧备注", blocks: [{ ...block, slotId: null }], locks: [] };
}

it.each(["title", "layout", "speakerNotes", "inlines"] as const)("deck restore rejects locked %s with zero writes", async (path) => {
  const e = await editor("html_deck"); const slide = container("html_deck"); const block = slide.blocks[0];
  if (block === undefined) throw new Error("missing block");
  await e.save([{ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node: slide }]);
  const nodeId = path === "inlines" ? block.id : slide.id;
  const history = await e.save([{ op: "setField", nodeId, path: "locks", value: [path] }]);
  await e.save([{ op: "setField", nodeId, path: "locks", value: [] }]);
  await e.save(path === "layout" ? [{ op: "setField", nodeId, path, value: "closing" }]
    : path === "inlines" ? [{ op: "setField", nodeId, path, value: [{ text: "新正文", marks: [] }] }]
    : [{ op: "setField", nodeId, path, value: "新文本" }]);
  await e.save([{ op: "setField", nodeId, path: "locks", value: [path] }]);
  const before = writes(e); const response = await e.restore(history.id);
  expect(response.status).toBe(409); expect(response.body).toMatchObject({ error: { code: "LOCKED_FIELD" } });
  expect(writes(e)).toEqual(before);
});

it.each(["children", "sections.*"])("root %s lock rejects child order changes", async (lock) => {
  const e = await editor(); const a = container("feishu_doc"), b = container("feishu_doc");
  await e.save([a,b].map(node => ({ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node })));
  const root = e.rendition.rootNodeId;
  const history = await e.save([{ op: "setField", nodeId: root, path: "locks", value: [lock] }]);
  await e.save([{ op: "setField", nodeId: root, path: "locks", value: [] }]);
  await e.save([{ op: "moveNode", nodeId: b.id, parentId: root, beforeId: a.id }]);
  await e.save([{ op: "setField", nodeId: root, path: "locks", value: [lock] }]);
  const before = writes(e); expect((await e.restore(history.id)).status).toBe(409); expect(writes(e)).toEqual(before);
});

it("doc section speakerNotes lock protects the root notes map entry", async () => {
  const e = await editor(); const a = container("feishu_doc");
  await e.save([{ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node: a }]);
  await e.save([{ op: "setField", nodeId: a.id, path: "speakerNotes", value: "旧备注" }]);
  const history = await e.save([{ op: "setField", nodeId: a.id, path: "locks", value: ["speakerNotes"] }]);
  await e.save([{ op: "setField", nodeId: a.id, path: "locks", value: [] }]);
  await e.save([{ op: "setField", nodeId: a.id, path: "speakerNotes", value: "新备注" }]);
  await e.save([{ op: "setField", nodeId: a.id, path: "locks", value: ["speakerNotes"] }]);
  const before = writes(e); expect((await e.restore(history.id)).status).toBe(409); expect(writes(e)).toEqual(before);
});

it("restore preserves a locked descendant when its unlocked ancestor disappears", async () => {
  const e = await editor(); const history = e.current(); const a = container("feishu_doc");
  const block = a.blocks[0]; if (block === undefined) throw new Error("missing block");
  await e.save([{ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node: a }]);
  await e.save([{ op: "setField", nodeId: block.id, path: "locks", value: ["inlines"] }]);
  const before = writes(e); expect((await e.restore(history)).status).toBe(409); expect(writes(e)).toEqual(before);
});

it("restore matches IDs across a new unlocked sibling and allows unrelated changes", async () => {
  const e = await editor(); const a = container("feishu_doc"), b = container("feishu_doc");
  await e.save([{ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node: a }]);
  const history = await e.save([{ op: "setField", nodeId: a.id, path: "locks", value: ["title"] }]);
  await e.save([{ op: "insertNode", parentId: e.rendition.rootNodeId, beforeId: a.id, node: b }]);
  expect((await e.restore(history.id)).status).toBe(201);
});

it("unlocked restore may change fields, reorder, insert and remove nodes", async () => {
  const e = await editor(); const a = container("feishu_doc"), b = container("feishu_doc");
  const history = await e.save([a,b].map(node => ({ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node })));
  await e.save([{ op: "moveNode", nodeId: b.id, parentId: e.rendition.rootNodeId, beforeId: a.id }, { op: "removeNode", nodeId: a.id }, { op: "setField", nodeId: b.id, path: "title", value: "新" }]);
  const response = await e.restore(history.id); expect(response.status).toBe(201);
  expect(ApiSuccessSchema(RevisionViewSchema).parse(response.body).data.ast).toEqual(history.ast);
});

function resolved(view: RevisionView) {
  if (view.evidence.kind === "unresolved") throw new Error("unresolved evidence");
  return view.evidence.evidence;
}
async function imageEditor() {
  const e = await editor(); const fixture = seedMediaFixture(e.app); const sectionId = randomUUID(); const blockId = randomUUID();
  const image = { id: blockId, type: "image" as const, assetVersionId: fixture.assetVersionId, derivativeId: fixture.derivativeId, occurrenceId: fixture.occurrenceId, caption: "图", alt: "图", fit: "contain" as const, provenance: [], locks: [] };
  const base = await e.save([{ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node: { id: sectionId, title: "图片", locks: [], blocks: [image] } }]);
  return { ...e, fixture, sectionId, blockId, image, base };
}

it.each(["canonical", "asset", "locator", "source"])("unchanged image inherits exact evidence after occurrence %s changes", async (change) => {
  const e = await imageEditor(); const other = seedMediaFixture(e.app, 1); const db = e.app.context.database.db;
  if (change === "canonical") db.prepare("UPDATE occurrences SET canonical_id = ?, version = version + 1 WHERE id = ?").run(other.occurrenceId, e.fixture.occurrenceId);
  if (change === "asset") db.prepare("UPDATE occurrences SET asset_id = NULL, version = version + 1 WHERE id = ?").run(e.fixture.occurrenceId);
  if (change === "locator") db.prepare("UPDATE occurrences SET locator_json = ?, version = version + 1 WHERE id = ?").run(JSON.stringify({ kind: "page", page: 9 }), e.fixture.occurrenceId);
  if (change === "source") db.prepare("UPDATE occurrences SET occurrence_index = 1, source_version_id = ?, version = version + 1 WHERE id = ?").run(other.sourceVersionId, e.fixture.occurrenceId);
  const next = await e.save([{ op: "setField", nodeId: e.rendition.rootNodeId, path: "title", value: "仅标题" }]);
  expect(resolved(next)).toEqual(resolved(e.base));
  if (change === "asset") expect(next.references.find(r => r.ref.refType === "occurrence")?.state.kind).toBe("missing");
});

it("changed tuple cannot use an inherited binding to bypass asset validation", async () => {
  const e = await imageEditor(); const other = seedMediaFixture(e.app, 1);
  const before = writes(e);
  const response = await e.post([{ op: "insertNode", parentId: e.sectionId, afterId: null, node: { ...e.image, id: randomUUID(), derivativeId: other.derivativeId } }]);
  expect(response.status).toBe(422); expect(response.body).toMatchObject({ error: { code: "UNKNOWN_REFERENCE" } }); expect(writes(e)).toEqual(before);
});

it("new valid tuple captures fresh occurrence evidence", async () => {
  const e = await imageEditor(); const other = seedMediaFixture(e.app, 1);
  const next = await e.save([{ op: "insertNode", parentId: e.sectionId, afterId: null, node: { ...e.image, id: randomUUID(), assetVersionId: other.assetVersionId, derivativeId: other.derivativeId, occurrenceId: other.occurrenceId } }]);
  expect(resolved(next).bindings).toHaveLength(2);
  expect(resolved(next).bindings).toEqual(expect.arrayContaining(resolved(e.base).bindings));
});

it("removing one image drops only its exclusive closure and retains shared refs", async () => {
  const e = await imageEditor(); const other = seedMediaFixture(e.app, 1); const otherId = randomUUID(), sharedId = randomUUID();
  await e.save([
    { op: "insertNode", parentId: e.sectionId, afterId: null, node: { ...e.image, id: sharedId } },
    { op: "insertNode", parentId: e.sectionId, afterId: null, node: { ...e.image, id: otherId, assetVersionId: other.assetVersionId, derivativeId: other.derivativeId, occurrenceId: other.occurrenceId } },
  ]);
  const oneRemoved = await e.save([{ op: "removeNode", nodeId: e.blockId }]);
  expect(resolved(oneRemoved).bindings).toHaveLength(2);
  const next = await e.save([{ op: "removeNode", nodeId: otherId }]);
  expect(resolved(next)).toEqual(resolved(e.base));
  const empty = await e.save([{ op: "removeNode", nodeId: sharedId }]);
  expect(resolved(empty)).toMatchObject({ directRefs: [], transitiveRefs: [], bindings: [], blobHashes: [] });
});

it("manual save refuses a legacy nonempty base without evidence", async () => {
  const e = await imageEditor(); const db = e.app.context.database.db;
  db.exec("DROP TRIGGER revision_evidence_immutable_delete");
  db.prepare("DELETE FROM revision_evidence WHERE revision_id = ?").run(e.base.id);
  const before = writes(e); const response = await e.post([{ op: "setField", nodeId: e.rendition.rootNodeId, path: "title", value: "标题" }]);
  expect(response.status).toBe(422); expect(response.body).toMatchObject({ error: { code: "REFERENCE_HISTORY_UNRESOLVED" } }); expect(writes(e)).toEqual(before);
});

it.each(["section", "root"] as const)("restore enforces %s ancestor field locks", async (owner) => {
  const e = await editor(); const a = container("feishu_doc"); const block = a.blocks[0]; if (block === undefined) throw new Error("missing block");
  await e.save([{ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node: a }]);
  const nodeId = owner === "section" ? a.id : e.rendition.rootNodeId;
  const locks = owner === "section" ? ["blocks.inlines.*"] : ["sections.blocks.inlines.*"];
  const history = await e.save([{ op: "setField", nodeId, path: "locks", value: locks }]);
  await e.save([{ op: "setField", nodeId, path: "locks", value: [] }]);
  await e.save([{ op: "setField", nodeId: block.id, path: "inlines", value: [{ text: "新", marks: [] }] }]);
  await e.save([{ op: "setField", nodeId, path: "locks", value: locks }]);
  const before = writes(e); expect((await e.restore(history.id)).status).toBe(409); expect(writes(e)).toEqual(before);
});

it("locked descendants cannot be moved between otherwise unlocked containers by restore", async () => {
  const e = await editor(); const a = container("feishu_doc"), b = container("feishu_doc");
  const block = a.blocks[0]; if (block === undefined) throw new Error("missing block");
  await e.save([a,b].map(node => ({ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node })));
  const history = await e.save([{ op: "setField", nodeId: block.id, path: "locks", value: ["inlines"] }]);
  await e.save([{ op: "setField", nodeId: block.id, path: "locks", value: [] }]);
  await e.save([{ op: "moveNode", nodeId: block.id, parentId: b.id, afterId: null }]);
  await e.save([{ op: "setField", nodeId: block.id, path: "locks", value: ["inlines"] }]);
  const before = writes(e); expect((await e.restore(history.id)).status).toBe(409); expect(writes(e)).toEqual(before);
});

it("changed image tuple uses current relationship validation even when every ID is already inherited", async () => {
  const e = await imageEditor();
  e.app.context.database.db.prepare("UPDATE occurrences SET asset_id = NULL, version = version + 1 WHERE id = ?").run(e.fixture.occurrenceId);
  const before = writes(e);
  const response = await e.post([{ op: "setField", nodeId: e.blockId, path: "derivativeId", value: null }]);
  expect(response.status).toBe(422); expect(response.body).toMatchObject({ error: { code: "UNKNOWN_REFERENCE" } }); expect(writes(e)).toEqual(before);
});

it("changed valid asset version captures a fresh binding instead of inheriting by occurrence ID alone", async () => {
  const e = await imageEditor(); const id = randomUUID(); const db = e.app.context.database.db;
  db.prepare("INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at) VALUES (?, ?, '新版本', '{}', '{}', 1, ?)").run(id, e.fixture.assetId, new Date().toISOString());
  db.prepare("UPDATE occurrences SET version = 4 WHERE id = ?").run(e.fixture.occurrenceId);
  const next = await e.save([{ op: "setField", nodeId: e.blockId, path: "assetVersionId", value: id }]);
  expect(resolved(next).bindings[0]?.observedVersion).toBe(4);
  expect(resolved(next).directRefs).toContainEqual({ refType: "asset_version", refId: id });
  expect(resolved(next).directRefs).not.toContainEqual({ refType: "asset_version", refId: e.fixture.assetVersionId });
});

it("changed source locator cannot reuse proof from the same sourceVersion ID", async () => {
  const e = await imageEditor(); const before = writes(e);
  const response = await e.post([{ op: "setField", nodeId: e.blockId, path: "provenance", value: [{ kind: "source", sourceVersionId: e.fixture.sourceVersionId, locator: { kind: "page", page: 999 } }] }]);
  expect(response.status).toBe(422); expect(writes(e)).toEqual(before);
});

it("manual save validates base evidence hash and never reconstructs corrupt proof", async () => {
  const e = await imageEditor(); const db = e.app.context.database.db;
  db.exec("DROP TRIGGER revision_evidence_immutable_update");
  db.prepare("UPDATE revision_evidence SET binding_hash = ? WHERE revision_id = ?").run("0".repeat(64), e.base.id);
  const before = writes(e); const response = await e.post([{ op: "setField", nodeId: e.rendition.rootNodeId, path: "title", value: "标题" }]);
  expect(response.status).toBe(422); expect(response.body).toMatchObject({ error: { code: "REFERENCE_HISTORY_UNRESOLVED" } }); expect(writes(e)).toEqual(before);
});

it.each(["valid", "wrongAsset", "pastEnd"] as const)("video segment tuple %s validates asset, derivative and actual duration", async (variant) => {
  const e = await editor(); const media = seedMediaFixture(e.app, 0, "video"); const other = seedMediaFixture(e.app, 1); const db = e.app.context.database.db;
  const versionId = randomUUID(), segmentId = randomUUID();
  db.prepare("INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at) VALUES (?, ?, 'video', ?, '{}', 1, ?)").run(versionId, media.assetId, JSON.stringify({ probe: { kind: "video", durationMs: 2500, width: 10, height: 10, videoCodec: "h264", fps: 24, audioCodec: null, frameCount: null } }), new Date().toISOString());
  db.prepare("INSERT INTO segments(id, asset_id, start_ms, end_ms, derivative_id, title, created_at) VALUES (?, ?, 0, ?, ?, 'segment', ?)").run(segmentId, variant === "wrongAsset" ? other.assetId : media.assetId, variant === "pastEnd" ? 2501 : 2500, media.derivativeId, new Date().toISOString());
  const before = writes(e);
  const response = await e.post([{ op: "insertNode", parentId: e.rendition.rootNodeId, afterId: null, node: { id: randomUUID(), title: "视频", locks: [], blocks: [{ id: randomUUID(), type: "video", assetVersionId: versionId, posterDerivativeId: media.derivativeId, segmentId, caption: "视频", locks: [], provenance: [] }] } }]);
  expect(response.status, JSON.stringify(response.body)).toBe(variant === "valid" ? 201 : 422);
  if (variant !== "valid") expect(writes(e)).toEqual(before);
});

it("current derivative availability cannot rewrite an unchanged historical closure", async () => {
  const e = await imageEditor();
  e.app.context.database.db.prepare("DELETE FROM derivatives WHERE id = ?").run(e.fixture.derivativeId);
  const next = await e.save([{ op: "setField", nodeId: e.rendition.rootNodeId, path: "title", value: "标题" }]);
  expect(resolved(next)).toEqual(resolved(e.base));
  expect(next.references.find(ref => ref.ref.refType === "derivative")?.state.kind).toBe("missing");
});

function seedMediaFixture(app: T02cTestApp, salt = 0, mediaKind = "image"): {
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
  const sourceBlob = String(1 + salt * 3).repeat(64);
  const assetBlob = String(2 + salt * 3).repeat(64);
  const derivativeBlob = String(3 + salt * 3).repeat(64);
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
    "INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(assetId, assetBlob, mediaKind, now, now);
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

