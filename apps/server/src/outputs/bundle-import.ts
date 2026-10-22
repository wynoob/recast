import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AstSchema,
  BundleTemplateVersionSchema,
  ProjectBundleImportPayloadSchema,
  type ProjectBundleEntities,
} from "@dmall/contracts";
import { deriveRevisionRefs } from "@dmall/domain";
import { canonicalHash } from "@dmall/templates";
import { ApiError } from "../errors.js";
import { insertRevisionRecord } from "../authoring/revision-commit.js";

export interface BundleImportReport {
  imported: Record<string, number>;
  reused: Record<string, number>;
  remapped: Record<string, number>;
  warnings: string[];
}

interface ImportedContent {
  contentId: string;
  renditionId: string;
  revisionId: string;
  report: BundleImportReport;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeWorkspacePath(workspace: string, relative: string): string {
  if (relative.includes("..") || relative.startsWith("/") || relative.includes("\\")) {
    throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "项目包包含越界文件路径" });
  }
  const full = resolve(join(workspace, relative));
  const root = resolve(workspace);
  if (!full.startsWith(`${root}/`)) {
    throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "项目包文件路径越界" });
  }
  return full;
}

function ensureBlob(input: {
  db: Database.Database;
  dataRoot: string;
  workspace: string;
  sha256: string;
  mime: string;
  bytes: number;
  workspacePath: string;
}): { reused: boolean } {
  const existing = input.db.prepare("SELECT mime, bytes FROM blobs WHERE sha256 = ?").get(input.sha256);
  if (existing !== undefined) return { reused: true };
  const source = safeWorkspacePath(input.workspace, input.workspacePath);
  if (!existsSync(source)) {
    throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "项目包媒体文件缺失" });
  }
  const actual = sha256File(source);
  if (actual !== input.sha256) {
    throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "项目包媒体哈希不匹配" });
  }
  const relative = join("blobs", "sha256", input.sha256.slice(0, 2), input.sha256);
  const destination = join(input.dataRoot, relative);
  mkdirSync(dirname(destination), { recursive: true });
  if (!existsSync(destination)) copyFileSync(source, destination);
  input.db.prepare(
    "INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(input.sha256, relative.split("\\").join("/"), input.mime, input.bytes, new Date().toISOString());
  return { reused: false };
}

function rewriteAst(value: unknown, ids: {
  assetVersion: Map<string, string>;
  derivative: Map<string, string>;
  occurrence: Map<string, string>;
  segment: Map<string, string>;
  sourceVersion: Map<string, string>;
  factVersion: Map<string, string>;
  message?: Map<string, string>;
}): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteAst(item, ids));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      const mapped =
        key === "assetVersionId" ? ids.assetVersion.get(child) :
        key === "derivativeId" || key === "posterDerivativeId" || key === "previewDerivativeId" ? ids.derivative.get(child) :
        key === "occurrenceId" ? ids.occurrence.get(child) :
        key === "segmentId" ? ids.segment.get(child) :
        key === "sourceVersionId" ? ids.sourceVersion.get(child) :
        key === "factVersionId" ? ids.factVersion.get(child) :
        key === "messageId" ? ids.message?.get(child) :
        undefined;
      output[key] = mapped ?? child;
    } else {
      output[key] = rewriteAst(child, ids);
    }
  }
  return output;
}

export function applyProjectBundleImport(input: {
  db: Database.Database;
  dataRoot: string;
  workspace: string;
  payloadPath: string;
  payloadSha256: string;
  titleOverride?: string;
}): ImportedContent {
  const raw = readFileSync(safeWorkspacePath(input.workspace, input.payloadPath));
  if (createHash("sha256").update(raw).digest("hex") !== input.payloadSha256) {
    throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "项目包规范化数据哈希不匹配" });
  }
  const payload = ProjectBundleImportPayloadSchema.parse(JSON.parse(raw.toString("utf8")) as unknown);
  const report: BundleImportReport = { imported: {}, reused: {}, remapped: {}, warnings: [] };
  for (const blob of payload.blobs) {
    const result = ensureBlob({
      db: input.db,
      dataRoot: input.dataRoot,
      workspace: input.workspace,
      sha256: blob.sha256,
      mime: blob.mime,
      bytes: blob.bytes,
      workspacePath: blob.workspacePath,
    });
    increment(result.reused ? report.reused : report.imported, "blobs");
  }

  const transaction = input.db.transaction((): ImportedContent => {
    const now = new Date().toISOString();
    const contentId = randomUUID();
    const content = payload.entities.contents[0];
    if (content === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "项目包缺少内容实体" });
    }
    const title = input.titleOverride?.trim() || `${content.title}（导入）`;
    input.db.prepare(
      `INSERT INTO contents
        (id, title, brief_json, merchant_id, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', 0, ?, ?)`,
    ).run(
      contentId,
      title,
      JSON.stringify({
        ...content.brief,
        contentId,
        targetKind: content.brief.targetKind,
      }),
      content.merchantId,
      now,
      now,
    );
    increment(report.imported, "contents");

    const templateVersionMap = importTemplates(input.db, payload.entities, report);
    const sourceMap = importSources(input.db, payload.entities, report);
    const assetMap = importAssets(input.db, payload.entities, sourceMap.versions, report);
    const factMap = importFacts(input.db, payload.entities, report);

    const renditionMap = new Map<string, string>();
    for (const rendition of payload.entities.renditions) {
      renditionMap.set(rendition.id, randomUUID());
    }
    const revisionMap = new Map<string, string>();
    for (const revision of payload.entities.revisions) revisionMap.set(revision.id, randomUUID());

    for (const rendition of payload.entities.renditions) {
      const id = renditionMap.get(rendition.id);
      if (id === undefined) throw new Error("rendition mapping missing");
      input.db.prepare(
        `INSERT INTO renditions
          (id, content_id, kind, label, root_node_id, current_revision_id,
           derived_from_revision_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, contentId, rendition.kind, rendition.label, rendition.rootNodeId, null, null, now, now);
      increment(report.imported, "renditions");
    }

    const conversationMap = new Map<string, string>();
    for (const conversation of payload.entities.conversations) {
      const id = randomUUID();
      conversationMap.set(conversation.id, id);
      input.db.prepare(
        "INSERT INTO conversations(id, content_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, contentId, conversation.title, conversation.createdAt, conversation.updatedAt);
      increment(report.imported, "conversations");
    }
    const messageMap = new Map<string, string>();
    for (const message of payload.entities.messages) {
      const conversationId = conversationMap.get(message.conversationId);
      if (conversationId === undefined) continue;
      const id = randomUUID();
      messageMap.set(message.id, id);
      input.db.prepare(
        `INSERT INTO messages
          (id, conversation_id, rendition_id, role, text, target_node_ids_json,
           candidate_id, created_at, mode, job_id, plan_id, transcript_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
      ).run(
        id,
        conversationId,
        message.renditionId === null ? null : renditionMap.get(message.renditionId) ?? null,
        message.role,
        message.text,
        JSON.stringify(message.targetNodeIds),
        message.createdAt,
        message.mode,
      );
      increment(report.imported, "messages");
    }

    const astIds = {
      assetVersion: assetMap.versions,
      derivative: assetMap.derivatives,
      occurrence: assetMap.occurrences,
      segment: assetMap.segments,
      sourceVersion: sourceMap.versions,
      factVersion: factMap.versions,
      message: messageMap,
    };
    for (const revision of payload.entities.revisions) {
      const id = revisionMap.get(revision.id);
      const renditionId = renditionMap.get(revision.renditionId);
      if (id === undefined || renditionId === undefined) throw new Error("revision mapping missing");
      const parentId = revision.parentId === null ? null : revisionMap.get(revision.parentId) ?? null;
      const templateVersionId = revision.templateVersionId === null
        ? null
        : templateVersionMap.get(revision.templateVersionId) ?? null;
      if (revision.templateVersionId !== null && templateVersionId === null) {
        throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "修订引用的模板版本未包含在项目包中" });
      }
      const ast = AstSchema.parse(rewriteAst(revision.ast, astIds));
      insertRevisionRecord(input.db, {
        schemaVersion: 1,
        id,
        renditionId,
        parentId,
        templateVersionId,
        ast,
        createdBy: revision.createdBy,
        reason: `${revision.reason}（项目包恢复）`,
        createdAt: revision.createdAt,
      });
      increment(report.imported, "revisions");
    }
    for (const rendition of payload.entities.renditions) {
      const mappedRevision = revisionMap.get(rendition.currentRevisionId);
      const mappedDerived = rendition.derivedFromRevisionId === null
        ? null
        : revisionMap.get(rendition.derivedFromRevisionId) ?? null;
      if (mappedRevision !== undefined) {
        input.db.prepare("UPDATE renditions SET current_revision_id = ?, derived_from_revision_id = ? WHERE id = ?")
          .run(mappedRevision, mappedDerived, renditionMap.get(rendition.id));
      }
    }
    const refMap: Record<string, Map<string, string>> = {
      asset_version: assetMap.versions,
      derivative: assetMap.derivatives,
      occurrence: assetMap.occurrences,
      segment: assetMap.segments,
      source_version: sourceMap.versions,
      fact_version: factMap.versions,
      template_version: templateVersionMap,
      message: messageMap,
    };
    for (const ref of payload.entities.revisionRefs) {
      const revisionId = revisionMap.get(ref.revisionId);
      if (revisionId === undefined) continue;
      const mapped = refMap[ref.refType]?.get(ref.refId);
      if (mapped === undefined) {
        throw new ApiError({
          statusCode: 422,
          code: "UNKNOWN_REFERENCE",
          message: `项目包引用无法解析：${ref.refType}/${ref.refId}`,
        });
      }
      input.db.prepare(
        "INSERT OR IGNORE INTO revision_refs(revision_id, ref_type, ref_id) VALUES (?, ?, ?)",
      ).run(revisionId, ref.refType, mapped);
    }
    for (const revision of payload.entities.revisions) {
      const revisionId = revisionMap.get(revision.id);
      if (revisionId === undefined) continue;
      const templateVersionId = revision.templateVersionId === null
        ? null
        : templateVersionMap.get(revision.templateVersionId) ?? null;
      const ast = AstSchema.parse(rewriteAst(revision.ast, astIds));
      const directRefs = deriveRevisionRefs({ ast, templateVersionId });
      const directRefsJson = JSON.stringify(directRefs);
      const bindingHash = createHash("sha256").update(directRefsJson).digest("hex");
      input.db.prepare(
        `INSERT INTO revision_evidence
          (revision_id, schema_version, direct_refs_json, transitive_refs_json, blob_hashes_json,
           bindings_json, binding_hash, created_at)
         VALUES (?, 1, ?, ?, '[]', '[]', ?, ?)`,
      ).run(revisionId, directRefsJson, directRefsJson, bindingHash, now);
    }

    const primaryRendition = payload.entities.renditions.find((rendition) => rendition.id === payload.entities.renditions[0]?.id);
    const primaryRevision = payload.entities.revisions.find((revision) => revision.id === primaryRendition?.currentRevisionId)
      ?? payload.entities.revisions[0];
    if (primaryRendition === undefined || primaryRevision === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "项目包缺少可恢复的当前修订" });
    }
    return {
      contentId,
      renditionId: renditionMap.get(primaryRendition.id) ?? "",
      revisionId: revisionMap.get(primaryRevision.id) ?? "",
      report,
    };
  });
  return transaction.immediate();
}

function importTemplates(
  db: Database.Database,
  entities: ProjectBundleEntities,
  report: BundleImportReport,
): Map<string, string> {
  const mapping = new Map<string, string>();
  const templateIdMap = new Map<string, string>();
  for (const template of entities.templates) templateIdMap.set(template.id, randomUUID());
  const versionsByTemplate = new Map<string, Array<z.infer<typeof BundleTemplateVersionSchema>>>();
  for (const version of entities.templateVersions) {
    const list = versionsByTemplate.get(version.templateId) ?? [];
    list.push(version);
    versionsByTemplate.set(version.templateId, list);
  }
  for (const template of entities.templates) {
    let newTemplateId = templateIdMap.get(template.id);
    if (newTemplateId === undefined) continue;
    const versions = (versionsByTemplate.get(template.id) ?? []).sort((a, b) => a.version - b.version);
    const existingVersions = versions.map((version) => {
      const existing = db.prepare(
        "SELECT id, template_id FROM template_versions WHERE package_hash = ? ORDER BY created_at LIMIT 1",
      ).get(version.packageHash);
      return existing === undefined
        ? null
        : z.strictObject({ id: z.uuid(), template_id: z.uuid() }).parse(existing);
    });
    if (versions.length > 0 && existingVersions.every((value) => value !== null)) {
      newTemplateId = existingVersions[0]?.template_id ?? newTemplateId;
      versions.forEach((version, index) => {
        const existing = existingVersions[index];
        if (existing !== null && existing !== undefined) mapping.set(version.id, existing.id);
      });
      increment(report.reused, "templateVersions");
      continue;
    }
    db.prepare(
      "INSERT INTO templates(id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(newTemplateId, template.kind, template.name, template.createdAt, template.updatedAt);
    increment(report.imported, "templates");
    let nextVersion = 1;
    for (const version of versions) {
      const existing = db.prepare(
        "SELECT id FROM template_versions WHERE package_hash = ? ORDER BY created_at LIMIT 1",
      ).get(version.packageHash);
      if (existing !== undefined) {
        const id = zUuid(existing);
        mapping.set(version.id, id);
        increment(report.reused, "templateVersions");
        continue;
      }
      const id = randomUUID();
      const hash = version.packageHash || canonicalHash(version.package);
      const mappedBase = version.baseVersionId === null
        ? null
        : mapping.get(version.baseVersionId) ?? null;
      db.prepare(
        `INSERT INTO template_versions
          (id, template_id, version, kind, narrative_json, layout_json, theme_json,
           capabilities_json, status, created_at, package_json, package_hash,
           base_version_id, change_summary, slots_json, renderer_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        newTemplateId,
        nextVersion,
        version.kind,
        JSON.stringify(version.narrative),
        JSON.stringify(version.layouts),
        JSON.stringify(version.theme),
        JSON.stringify(version.capabilities),
        version.status,
        version.createdAt,
        JSON.stringify(version.package),
        hash,
        mappedBase,
        version.changeSummary ?? "项目包恢复模板",
        JSON.stringify(version.slots),
        version.rendererVersion,
      );
      mapping.set(version.id, id);
      nextVersion += 1;
      increment(report.imported, "templateVersions");
    }
  }
  return mapping;
}

function importSources(
  db: Database.Database,
  entities: ProjectBundleEntities,
  report: BundleImportReport,
): { sources: Map<string, string>; versions: Map<string, string> } {
  const sources = new Map<string, string>();
  const versions = new Map<string, string>();
  for (const source of entities.sources) {
    const existing = db.prepare("SELECT id FROM sources WHERE canonical_key = ?").get(source.canonicalKey);
    if (existing !== undefined) {
      sources.set(source.id, zUuid(existing));
      increment(report.reused, "sources");
    } else {
      db.prepare(
        `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(source.id, source.kind, source.canonicalKey, source.title, source.originalUri, source.status, source.createdAt, source.updatedAt);
      sources.set(source.id, source.id);
      increment(report.imported, "sources");
    }
  }
  for (const version of entities.sourceVersions) {
    const sourceId = sources.get(version.sourceId);
    if (sourceId === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "来源版本缺少来源身份" });
    }
    const existing = db.prepare(
      "SELECT id FROM source_versions WHERE source_id = ? AND fingerprint = ?",
    ).get(sourceId, version.fingerprint);
    if (existing !== undefined) {
      versions.set(version.id, zUuid(existing));
      increment(report.reused, "sourceVersions");
      continue;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO source_versions
        (id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sourceId, version.fingerprint, version.snapshotBlobHash, version.remoteRevision, version.capturedAt, version.createdAt);
    versions.set(version.id, id);
    increment(report.imported, "sourceVersions");
  }
  return { sources, versions };
}

function importAssets(
  db: Database.Database,
  entities: ProjectBundleEntities,
  sourceVersions: Map<string, string>,
  report: BundleImportReport,
): {
  assets: Map<string, string>;
  versions: Map<string, string>;
  occurrences: Map<string, string>;
  derivatives: Map<string, string>;
  segments: Map<string, string>;
} {
  const now = new Date().toISOString();
  const assets = new Map<string, string>();
  const versions = new Map<string, string>();
  const occurrences = new Map<string, string>();
  const derivatives = new Map<string, string>();
  const segments = new Map<string, string>();
  for (const asset of entities.assets) {
    const existingByHash = db.prepare("SELECT id FROM assets WHERE blob_hash = ?").get(asset.blobHash);
    if (existingByHash !== undefined) {
      assets.set(asset.id, zUuid(existingByHash));
      increment(report.reused, "assets");
    } else {
      db.prepare(
        "INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(asset.id, asset.blobHash, asset.mediaKind, asset.createdAt, asset.updatedAt);
      assets.set(asset.id, asset.id);
      increment(report.imported, "assets");
    }
  }
  for (const version of entities.assetVersions) {
    const assetId = assets.get(version.assetId);
    if (assetId === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "素材版本缺少素材身份" });
    }
    const existing = db.prepare(
      `SELECT id FROM asset_versions
       WHERE asset_id = ? AND title = ? AND metadata_json = ? AND human_fields_json = ?`,
    ).get(assetId, version.title, JSON.stringify(version.metadata), JSON.stringify(version.humanFields));
    if (existing !== undefined) {
      versions.set(version.id, zUuid(existing));
      increment(report.reused, "assetVersions");
      continue;
    }
    const id = randomUUID();
    const next = db.prepare(
      "SELECT COALESCE(MAX(version), -1) + 1 AS version FROM asset_versions WHERE asset_id = ?",
    ).get(assetId);
    db.prepare(
      `INSERT INTO asset_versions
        (id, asset_id, title, metadata_json, human_fields_json, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, assetId, version.title, JSON.stringify(version.metadata), JSON.stringify(version.humanFields), zInt(next), now);
    versions.set(version.id, id);
    increment(report.imported, "assetVersions");
  }
  for (const occurrence of entities.occurrences) {
    const sourceVersionId = sourceVersions.get(occurrence.sourceVersionId);
    if (sourceVersionId === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "出现位置缺少来源版本" });
    }
    const assetId = occurrence.assetId === null ? null : assets.get(occurrence.assetId) ?? null;
    const locator = JSON.stringify(occurrence.locator);
    const existing = db.prepare(
      `SELECT id FROM occurrences
       WHERE source_version_id = ? AND locator_json = ? AND occurrence_index = ?`,
    ).get(sourceVersionId, locator, occurrence.occurrenceIndex);
    if (existing !== undefined) {
      occurrences.set(occurrence.id, zUuid(existing));
      increment(report.reused, "occurrences");
      continue;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO occurrences
        (id, source_version_id, asset_id, locator_json, occurrence_index, heading_path,
         before_text, after_text, media_status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, sourceVersionId, assetId, locator, occurrence.occurrenceIndex, occurrence.headingPath, occurrence.beforeText, occurrence.afterText, occurrence.mediaStatus, now, now);
    occurrences.set(occurrence.id, id);
    increment(report.imported, "occurrences");
  }
  for (const derivative of entities.derivatives) {
    const assetId = assets.get(derivative.assetId);
    if (assetId === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "派生媒体缺少素材身份" });
    }
    const existing = db.prepare(
      "SELECT id FROM derivatives WHERE asset_id = ? AND recipe_hash = ?",
    ).get(assetId, derivative.recipeHash);
    if (existing !== undefined) {
      derivatives.set(derivative.id, zUuid(existing));
      increment(report.reused, "derivatives");
      continue;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO derivatives
        (id, asset_id, kind, recipe_json, recipe_hash, blob_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, assetId, derivative.kind, JSON.stringify(derivative.recipe), derivative.recipeHash, derivative.blobHash, derivative.status, now);
    derivatives.set(derivative.id, id);
    increment(report.imported, "derivatives");
  }
  for (const segment of entities.segments) {
    const assetId = assets.get(segment.assetId);
    if (assetId === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "片段缺少素材身份" });
    }
    const existing = db.prepare(
      "SELECT id FROM segments WHERE asset_id = ? AND start_ms = ? AND end_ms = ? AND title = ?",
    ).get(assetId, segment.startMs, segment.endMs, segment.title);
    if (existing !== undefined) {
      segments.set(segment.id, zUuid(existing));
      increment(report.reused, "segments");
      continue;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO segments(id, asset_id, start_ms, end_ms, derivative_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, assetId, segment.startMs, segment.endMs, segment.derivativeId === null ? null : derivatives.get(segment.derivativeId) ?? null, segment.title, now);
    segments.set(segment.id, id);
    increment(report.imported, "segments");
  }
  return { assets, versions, occurrences, derivatives, segments };
}

function importFacts(
  db: Database.Database,
  entities: ProjectBundleEntities,
  report: BundleImportReport,
): { facts: Map<string, string>; versions: Map<string, string> } {
  const facts = new Map<string, string>();
  const versions = new Map<string, string>();
  for (const fact of entities.facts) {
    const existing = db.prepare("SELECT id FROM facts WHERE canonical_key = ?").get(fact.canonicalKey);
    if (existing !== undefined) {
      facts.set(fact.id, zUuid(existing));
      increment(report.reused, "facts");
    } else {
      db.prepare("INSERT INTO facts(id, canonical_key, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(fact.id, fact.canonicalKey, fact.createdAt, fact.updatedAt);
      facts.set(fact.id, fact.id);
      increment(report.imported, "facts");
    }
  }
  for (const version of entities.factVersions) {
    const factId = facts.get(version.factId);
    if (factId === undefined) {
      throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "事实版本缺少事实身份" });
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO fact_versions
        (id, fact_id, value_json, unit, merchant_id, period_json, kind, source_locator_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      factId,
      JSON.stringify(version.value),
      version.unit,
      version.merchantId,
      version.period === null ? null : JSON.stringify(version.period),
      version.kind,
      JSON.stringify(version.sourceLocator),
      version.status,
      version.createdAt,
    );
    versions.set(version.id, id);
    increment(report.imported, "factVersions");
  }
  return { facts, versions };
}

function zUuid(value: unknown): string {
  const parsed = z.strictObject({ id: z.uuid() }).parse(value);
  return parsed.id;
}

function zInt(value: unknown): number {
  const parsed = z.strictObject({ version: z.int().nonnegative() }).parse(value);
  return parsed.version;
}
