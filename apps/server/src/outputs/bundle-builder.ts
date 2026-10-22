import type Database from "better-sqlite3";
import { z } from "zod";
import {
  BundleAssetSchema,
  BundleAssetVersionSchema,
  BundleBlobRecordSchema,
  BundleContentSchema,
  BundleConversationSchema,
  BundleDerivativeSchema,
  BundleFactSchema,
  BundleFactVersionSchema,
  BundleMessageSchema,
  BundleOccurrenceSchema,
  BundleRenditionSchema,
  BundleRevisionRefSchema,
  BundleRevisionSchema,
  BundleSegmentSchema,
  BundleSourceSchema,
  BundleSourceVersionSchema,
  BundleTemplateSchema,
  BundleTemplateVersionSchema,
  ProjectBundleEntitiesSchema,
  type Ast,
  type BundleBlobRecord,
  type ProjectBundleEntities,
} from "@dmall/contracts";
import { canonicalHash } from "@dmall/templates";
import type { BlobStore } from "@dmall/storage";
import { ApiError } from "../errors.js";

const RowSchema = z.record(z.string(), z.unknown());

export interface ProjectBundlePlan {
  entities: ProjectBundleEntities;
  blobs: BundleBlobRecord[];
  selections: Array<{ renditionId: string; revisionIds: string[] }>;
}

function rows<T extends z.ZodType>(schema: T, values: unknown[]): z.infer<T>[] {
  return z.array(schema).parse(values) as z.infer<T>[];
}

function walkAstReferences(
  ast: Ast,
  out: {
    assetVersionIds: Set<string>;
    derivativeIds: Set<string>;
    occurrenceIds: Set<string>;
    segmentIds: Set<string>;
    sourceVersionIds: Set<string>;
    factVersionIds: Set<string>;
  },
): void {
  const blocks = ast.kind === "feishu_doc"
    ? ast.sections.flatMap((section) => section.blocks)
    : ast.slides.flatMap((slide) => slide.blocks);
  for (const block of blocks) {
    if (block.type === "image") {
      out.assetVersionIds.add(block.assetVersionId);
      if (block.derivativeId !== null) out.derivativeIds.add(block.derivativeId);
      out.occurrenceIds.add(block.occurrenceId);
    } else if (block.type === "video") {
      out.assetVersionIds.add(block.assetVersionId);
      if (block.segmentId !== null) out.segmentIds.add(block.segmentId);
      out.derivativeIds.add(block.posterDerivativeId);
    } else if (block.type === "readonly_source_block") {
      out.sourceVersionIds.add(block.sourceVersionId);
      if (block.previewDerivativeId !== null) out.derivativeIds.add(block.previewDerivativeId);
    }
    for (const provenance of block.provenance) {
      if (provenance.kind === "source") out.sourceVersionIds.add(provenance.sourceVersionId);
      if (provenance.kind === "fact") out.factVersionIds.add(provenance.factVersionId);
    }
  }
}

export async function buildProjectBundlePlan(input: {
  db: Database.Database;
  blobs: BlobStore;
  contentId: string;
  primaryRevisionId: string;
  selectedRevisionIds?: string[];
}): Promise<ProjectBundlePlan> {
  const { db } = input;
  const contentRow = db.prepare(
    "SELECT * FROM contents WHERE id = ?",
  ).get(input.contentId);
  if (contentRow === undefined) {
    throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "内容不存在" });
  }
  const content = RowSchema.parse(contentRow);
  const contentEntity = BundleContentSchema.parse({
    id: content.id,
    title: content.title,
    brief: JSON.parse(String(content.brief_json)) as unknown,
    merchantId: content.merchant_id,
    status: content.status,
    version: content.version,
    createdAt: content.created_at,
    updatedAt: content.updated_at,
  });

  const renditionRows = rows(BundleRenditionSchema, db.prepare(
    `SELECT id, content_id AS contentId, kind, label, root_node_id AS rootNodeId,
            current_revision_id AS currentRevisionId,
            derived_from_revision_id AS derivedFromRevisionId,
            version, created_at AS createdAt, updated_at AS updatedAt
     FROM renditions WHERE content_id = ? ORDER BY created_at, id`,
  ).all(input.contentId));

  const requested = input.selectedRevisionIds === undefined
    ? null
    : new Set(input.selectedRevisionIds);
  const summaryRevision = db.prepare(
    "SELECT rendition_id FROM revisions WHERE id = ?",
  ).get(input.primaryRevisionId);
  if (summaryRevision === undefined) {
    throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "修订版本不存在" });
  }
  const requiredRendition = z.strictObject({ rendition_id: z.uuid() }).parse(summaryRevision).rendition_id;
  const includedRenditions = renditionRows.filter((rendition) =>
    rendition.id === requiredRendition ||
    (requested !== null && [...requested].some((id) => db.prepare(
      "SELECT 1 FROM revisions WHERE id = ? AND rendition_id = ?",
    ).get(id, rendition.id) !== undefined)),
  );
  const includedRenditionIds = new Set(includedRenditions.map((rendition) => rendition.id));
  const revisionRows = db.prepare(
    `SELECT id, rendition_id AS renditionId, parent_id AS parentId,
            template_version_id AS templateVersionId, ast_json AS ast,
            created_by AS createdBy, reason, created_at AS createdAt
     FROM revisions WHERE rendition_id = ? ORDER BY created_at, id`,
  ).all(requiredRendition).map((row) => {
    const raw = RowSchema.parse(row);
    return BundleRevisionSchema.parse({
      ...raw,
      ast: JSON.parse(String(raw.ast)) as unknown,
    });
  }).filter((revision) => {
    if (!includedRenditionIds.has(revision.renditionId)) return false;
    if (requested === null) return true;
    if (requested.has(revision.id)) return true;
    const rendition = includedRenditions.find((item) => item.id === revision.renditionId);
    return rendition?.currentRevisionId === revision.id || revision.id === input.primaryRevisionId;
  });
  for (const rendition of includedRenditions) {
    if (!revisionRows.some((revision) => revision.id === rendition.currentRevisionId)) {
      const current = db.prepare(
        `SELECT id, rendition_id AS renditionId, parent_id AS parentId,
                template_version_id AS templateVersionId, ast_json AS ast,
                created_by AS createdBy, reason, created_at AS createdAt
         FROM revisions WHERE id = ? AND rendition_id = ?`,
      ).get(rendition.currentRevisionId, rendition.id);
      if (current !== undefined) {
        const raw = RowSchema.parse(current);
        revisionRows.push(BundleRevisionSchema.parse({
          ...raw,
          ast: JSON.parse(String(raw.ast)) as unknown,
        }));
      }
    }
  }
  const includedRevisions = revisionRows.filter((revision) => includedRenditionIds.has(revision.renditionId));
  const includedRevisionIds = new Set(includedRevisions.map((revision) => revision.id));
  const revisionRefs = rows(BundleRevisionRefSchema, db.prepare(
    "SELECT revision_id AS revisionId, ref_type AS refType, ref_id AS refId FROM revision_refs WHERE revision_id = ? ORDER BY ref_type, ref_id",
  ).all(input.primaryRevisionId).filter((row) => {
    const ref = BundleRevisionRefSchema.parse(row);
    return includedRevisionIds.has(ref.revisionId);
  }));
  for (const revisionId of includedRevisionIds) {
    const extra = db.prepare(
      "SELECT revision_id AS revisionId, ref_type AS refType, ref_id AS refId FROM revision_refs WHERE revision_id = ? ORDER BY ref_type, ref_id",
    ).all(revisionId);
    for (const row of extra) {
      const ref = BundleRevisionRefSchema.parse(row);
      if (!revisionRefs.some((item) => item.revisionId === ref.revisionId && item.refType === ref.refType && item.refId === ref.refId)) {
        revisionRefs.push(ref);
      }
    }
  }

  const refs = {
    assetVersionIds: new Set<string>(),
    derivativeIds: new Set<string>(),
    occurrenceIds: new Set<string>(),
    segmentIds: new Set<string>(),
    sourceVersionIds: new Set<string>(),
    factVersionIds: new Set<string>(),
  };
  for (const revision of includedRevisions) walkAstReferences(revision.ast, refs);
  for (const ref of revisionRefs) {
    if (ref.refType === "asset_version") refs.assetVersionIds.add(ref.refId);
    if (ref.refType === "derivative") refs.derivativeIds.add(ref.refId);
    if (ref.refType === "occurrence") refs.occurrenceIds.add(ref.refId);
    if (ref.refType === "segment") refs.segmentIds.add(ref.refId);
    if (ref.refType === "source_version") refs.sourceVersionIds.add(ref.refId);
    if (ref.refType === "fact_version") refs.factVersionIds.add(ref.refId);
  }

  const assetVersionRows = refs.assetVersionIds.size === 0 ? [] : db.prepare(
    `SELECT id, asset_id AS assetId, title, metadata_json AS metadata,
            human_fields_json AS humanFields, version, created_at AS createdAt
     FROM asset_versions WHERE id IN (${placeholders(refs.assetVersionIds.size)})`,
  ).all(...refs.assetVersionIds);
  const assetVersions = assetVersionRows.map((row) => {
    const raw = RowSchema.parse(row);
    return BundleAssetVersionSchema.parse({
      ...raw,
      metadata: JSON.parse(String(raw.metadata)) as unknown,
      humanFields: JSON.parse(String(raw.humanFields)) as unknown,
    });
  });
  const assetIds = new Set(assetVersions.map((item) => item.assetId));
  const occurrenceIds = new Set(refs.occurrenceIds);
  const occurrenceRows = occurrenceIds.size === 0 ? [] : db.prepare(
    `SELECT id, source_version_id AS sourceVersionId, asset_id AS assetId, locator_json AS locator,
            occurrence_index AS occurrenceIndex, heading_path AS headingPath,
            before_text AS beforeText, after_text AS afterText, media_status AS mediaStatus,
            version, created_at AS createdAt, updated_at AS updatedAt
     FROM occurrences WHERE id IN (${placeholders(occurrenceIds.size)})`,
  ).all(...occurrenceIds);
  const occurrences = occurrenceRows.map((row) => {
    const raw = RowSchema.parse(row);
    return BundleOccurrenceSchema.parse({
      ...raw,
      locator: JSON.parse(String(raw.locator)) as unknown,
    });
  });
  for (const occurrence of occurrences) refs.sourceVersionIds.add(occurrence.sourceVersionId);
  const segments = refs.segmentIds.size === 0 ? [] : rows(BundleSegmentSchema, db.prepare(
    `SELECT id, asset_id AS assetId, start_ms AS startMs, end_ms AS endMs,
            derivative_id AS derivativeId, title, created_at AS createdAt
     FROM segments WHERE id IN (${placeholders(refs.segmentIds.size)})`,
  ).all(...refs.segmentIds));
  for (const segment of segments) {
    assetIds.add(segment.assetId);
    if (segment.derivativeId !== null) refs.derivativeIds.add(segment.derivativeId);
  }
  const derivRows = refs.derivativeIds.size === 0 ? [] : db.prepare(
    `SELECT id, asset_id, kind, recipe_json, recipe_hash, blob_hash, status, created_at
     FROM derivatives WHERE id IN (${placeholders(refs.derivativeIds.size)})`,
  ).all(...refs.derivativeIds);
  for (const row of derivRows) {
    const parsed = z.strictObject({ asset_id: z.uuid(), blob_hash: z.string() }).passthrough().parse(row);
    assetIds.add(parsed.asset_id);
  }
  const assets = assetIds.size === 0 ? [] : rows(BundleAssetSchema, db.prepare(
    `SELECT id, blob_hash AS blobHash, media_kind AS mediaKind,
            created_at AS createdAt, updated_at AS updatedAt
     FROM assets WHERE id IN (${placeholders(assetIds.size)})`,
  ).all(...assetIds));
  const derivativeRows = refs.derivativeIds.size === 0 ? [] : db.prepare(
    `SELECT id, asset_id AS assetId, kind, recipe_json AS recipe, recipe_hash AS recipeHash,
            blob_hash AS blobHash, status, created_at AS createdAt
     FROM derivatives WHERE id IN (${placeholders(refs.derivativeIds.size)})`,
  ).all(...refs.derivativeIds);
  const derivatives = derivativeRows.map((row) => {
    const raw = RowSchema.parse(row);
    return BundleDerivativeSchema.parse({
      ...raw,
      recipe: JSON.parse(String(raw.recipe)) as unknown,
    });
  });
  const sourceVersions = refs.sourceVersionIds.size === 0 ? [] : rows(BundleSourceVersionSchema, db.prepare(
    `SELECT id, source_id AS sourceId, fingerprint, snapshot_blob_hash AS snapshotBlobHash,
            remote_revision AS remoteRevision, captured_at AS capturedAt, created_at AS createdAt
     FROM source_versions WHERE id IN (${placeholders(refs.sourceVersionIds.size)})`,
  ).all(...refs.sourceVersionIds));
  const sourceIds = new Set(sourceVersions.map((version) => version.sourceId));
  const sources = sourceIds.size === 0 ? [] : rows(BundleSourceSchema, db.prepare(
    `SELECT id, kind, canonical_key AS canonicalKey, title, original_uri AS originalUri,
            status, created_at AS createdAt, updated_at AS updatedAt
     FROM sources WHERE id IN (${placeholders(sourceIds.size)})`,
  ).all(...sourceIds));
  const factRows = refs.factVersionIds.size === 0 ? [] : db.prepare(
    `SELECT id, fact_id AS factId, value_json AS value, unit, merchant_id AS merchantId,
            period_json AS period, kind, source_locator_json AS sourceLocator, status,
            created_at AS createdAt FROM fact_versions WHERE id IN (${placeholders(refs.factVersionIds.size)})`,
  ).all(...refs.factVersionIds);
  const facts = factRows.map((row) => {
    const raw = RowSchema.parse(row);
    return BundleFactVersionSchema.parse({
      ...raw,
      value: JSON.parse(String(raw.value)) as unknown,
      period: raw.period === null ? null : JSON.parse(String(raw.period)) as unknown,
      sourceLocator: JSON.parse(String(raw.sourceLocator)) as unknown,
    });
  });
  const factIds = new Set(facts.map((fact) => fact.factId));
  const factIdentities = factIds.size === 0 ? [] : rows(BundleFactSchema, db.prepare(
    `SELECT id, canonical_key AS canonicalKey, created_at AS createdAt, updated_at AS updatedAt
     FROM facts WHERE id IN (${placeholders(factIds.size)})`,
  ).all(...factIds));

  const templateVersionIds = new Set(
    includedRevisions.flatMap((revision) => revision.templateVersionId === null ? [] : [revision.templateVersionId]),
  );
  const templateVersionRows = templateVersionIds.size === 0 ? [] : db.prepare(
    `SELECT id, template_id, version, kind, narrative_json, layout_json, theme_json,
            capabilities_json, status, package_json, package_hash, base_version_id,
            change_summary, slots_json, renderer_version, created_at
     FROM template_versions WHERE id IN (${placeholders(templateVersionIds.size)})`,
  ).all(...templateVersionIds);
  const templateVersions = templateVersionRows.map((row) => {
    const raw = RowSchema.parse(row);
    if (raw.package_json === null || raw.package_json === undefined) {
      throw new ApiError({
        statusCode: 422,
        code: "TEMPLATE_INVALID",
        message: `模板版本 ${String(raw.id)} 缺少完整包快照，不能打包`,
      });
    }
    const packageValue = JSON.parse(String(raw.package_json)) as unknown;
    return BundleTemplateVersionSchema.parse({
      id: raw.id,
      templateId: raw.template_id,
      version: raw.version,
      kind: raw.kind,
      narrative: JSON.parse(String(raw.narrative_json)) as unknown,
      layouts: JSON.parse(String(raw.layout_json)) as unknown,
      theme: JSON.parse(String(raw.theme_json)) as unknown,
      capabilities: JSON.parse(String(raw.capabilities_json)) as unknown,
      status: raw.status,
      package: packageValue,
      packageHash: raw.package_hash ?? canonicalHash(packageValue),
      baseVersionId: raw.base_version_id,
      changeSummary: raw.change_summary,
      slots: JSON.parse(String(raw.slots_json ?? "[]")) as unknown,
      rendererVersion: raw.renderer_version,
      createdAt: raw.created_at,
    });
  });
  const templateIds = new Set(templateVersions.map((version) => version.templateId));
  const templates = templateIds.size === 0 ? [] : rows(BundleTemplateSchema, db.prepare(
    `SELECT id, kind, name, created_at AS createdAt, updated_at AS updatedAt
     FROM templates WHERE id IN (${placeholders(templateIds.size)})`,
  ).all(...templateIds));

  const conversations = rows(BundleConversationSchema, db.prepare(
    `SELECT id, content_id AS contentId, title, created_at AS createdAt, updated_at AS updatedAt
     FROM conversations WHERE content_id = ? ORDER BY created_at, id`,
  ).all(input.contentId));
  const conversationIds = new Set(conversations.map((conversation) => conversation.id));
  const messageRows = conversationIds.size === 0 ? [] : db.prepare(
    `SELECT id, conversation_id, rendition_id, role, text, target_node_ids_json,
            candidate_id, mode, job_id, plan_id, transcript_id, created_at
     FROM messages WHERE conversation_id IN (${placeholders(conversationIds.size)})
     ORDER BY created_at, id`,
  ).all(...conversationIds);
  const messages = messageRows.map((row) => {
    const raw = RowSchema.parse(row);
    return BundleMessageSchema.parse({
      id: raw.id,
      conversationId: raw.conversation_id,
      renditionId: raw.rendition_id,
      role: raw.role,
      text: raw.text,
      targetNodeIds: JSON.parse(String(raw.target_node_ids_json)) as unknown,
      candidateId: raw.candidate_id,
      mode: raw.mode,
      jobId: raw.job_id,
      planId: raw.plan_id,
      transcriptId: raw.transcript_id,
      createdAt: raw.created_at,
    });
  });

  const entities = ProjectBundleEntitiesSchema.parse({
    contents: [contentEntity],
    renditions: includedRenditions,
    revisions: includedRevisions,
    revisionRefs,
    templates,
    templateVersions,
    sources,
    sourceVersions,
    assets,
    assetVersions,
    occurrences,
    derivatives,
    segments,
    facts: factIdentities,
    factVersions: facts,
    conversations,
    messages,
  });

  const blobHashes = new Set<string>();
  for (const asset of entities.assets) blobHashes.add(asset.blobHash);
  for (const derivative of entities.derivatives) blobHashes.add(derivative.blobHash);
  for (const version of entities.sourceVersions) blobHashes.add(version.snapshotBlobHash);
  const blobs: BundleBlobRecord[] = [];
  for (const sha256 of blobHashes) {
    const row = db.prepare("SELECT mime, bytes FROM blobs WHERE sha256 = ?").get(sha256);
    if (row === undefined) {
      throw new ApiError({
        statusCode: 422,
        code: "EXPORT_MEDIA_MISSING",
        message: `项目包引用的文件元数据缺失：${sha256.slice(0, 12)}`,
      });
    }
    const descriptor = await input.blobs.describe(sha256);
    if (descriptor === null || !(await input.blobs.verify(sha256))) {
      throw new ApiError({
        statusCode: 422,
        code: "EXPORT_MEDIA_MISSING",
        message: `项目包引用的文件不存在或校验失败：${sha256.slice(0, 12)}`,
      });
    }
    const meta = z.strictObject({ mime: z.string(), bytes: z.int().nonnegative() }).parse(row);
    blobs.push(BundleBlobRecordSchema.parse({
      sha256,
      bytes: descriptor.bytes,
      mime: meta.mime,
      path: `blobs/${sha256}`,
    }));
  }

  return {
    entities,
    blobs,
    selections: includedRenditions.map((rendition) => ({
      renditionId: rendition.id,
      revisionIds: includedRevisions.filter((revision) => revision.renditionId === rendition.id).map((revision) => revision.id),
    })).filter((selection) => selection.revisionIds.length > 0),
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}
