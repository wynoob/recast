import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  FixedEvidenceSchema,
  type ChunkEntity,
  type FixedEvidence,
  type SelectionView,
} from "@dmall/contracts";
import { ApiError } from "./errors.js";
import type { RetrievalService } from "./retrieval/retrieval-service.js";
import { evidenceEntityHash, evidenceIndexTextHash } from "./authoring/evidence-hash.js";

const EvidenceRowSchema = z.strictObject({
  id: z.uuid(),
  content_id: z.uuid(),
  selection_handle: z.string(),
  kind: z.enum(["source", "fact", "media", "user_assertion"]),
  entity_json: z.string(),
  entity_hash: z.string(),
  index_text_hash: z.string().nullable(),
});

export class AuthoringEvidenceService {
  private readonly db: Database.Database;
  private readonly retrieval: RetrievalService;

  constructor(input: { db: Database.Database; retrieval: RetrievalService }) {
    this.db = input.db;
    this.retrieval = input.retrieval;
  }

  select(contentId: string, handles: readonly string[]): FixedEvidence[] {
    return this.db.transaction(() => handles.flatMap((handle) => {
      const existing = this.findByHandle(contentId, handle);
      if (existing.length > 0) return existing;
      const selection = this.retrieval.getSelection(handle);
      const evidenceItems = this.fromSelection(selection);
      for (const evidence of evidenceItems) {
        this.db.prepare(
          `INSERT INTO authoring_evidence(
            id, content_id, selection_handle, kind, entity_json, entity_hash, index_text_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          evidence.evidenceId,
          contentId,
          handle,
          evidence.kind,
          JSON.stringify(evidence),
          evidenceEntityHash(evidence),
          evidenceIndexTextHash(evidence),
          new Date().toISOString(),
        );
      }
      return evidenceItems;
    }))();
  }

  list(contentId: string, ids?: readonly string[]): FixedEvidence[] {
    const rows = ids === undefined
      ? this.db.prepare(
          "SELECT id, content_id, selection_handle, kind, entity_json, entity_hash, index_text_hash FROM authoring_evidence WHERE content_id = ? ORDER BY created_at, id",
        ).all(contentId)
      : ids.map((id) => {
          const row = this.db.prepare(
            "SELECT id, content_id, selection_handle, kind, entity_json, entity_hash, index_text_hash FROM authoring_evidence WHERE content_id = ? AND id = ?",
          ).get(contentId, id);
          if (row === undefined) {
            throw new ApiError({
              statusCode: 422,
              code: "UNKNOWN_REFERENCE",
              message: "固定证据不存在或不属于该内容",
              details: { evidenceId: id },
            });
          }
          return row;
        });
    return z.array(EvidenceRowSchema).parse(rows).map((row) => {
      const parsed = FixedEvidenceSchema.parse(JSON.parse(row.entity_json) as unknown);
      if (parsed.evidenceId !== row.id) throw new Error("证据行 ID 与实体不一致");
      return parsed;
    });
  }

  byIds(ids: readonly string[]): FixedEvidence[] {
    if (ids.length === 0) return [];
    const rows = ids.map((id) => this.db.prepare(
      "SELECT id, content_id, selection_handle, kind, entity_json, entity_hash, index_text_hash FROM authoring_evidence WHERE id = ?",
    ).get(id)).filter((row): row is Record<string, unknown> => row !== undefined);
    return z.array(EvidenceRowSchema).parse(rows).map((row) =>
      FixedEvidenceSchema.parse(JSON.parse(row.entity_json) as unknown));
  }

  fixedEvidenceForVersion(factVersionId: string): FixedEvidence | null {
    const rows = this.db.prepare(
      "SELECT id, content_id, selection_handle, kind, entity_json, entity_hash, index_text_hash FROM authoring_evidence WHERE kind = 'fact' ORDER BY created_at DESC",
    ).all();
    for (const row of z.array(EvidenceRowSchema).parse(rows)) {
      const item = FixedEvidenceSchema.parse(JSON.parse(row.entity_json) as unknown);
      if (item.kind === "fact" && item.entity.factVersionId === factVersionId) return item;
    }
    return null;
  }

  private findByHandle(contentId: string, handle: string): FixedEvidence[] {
    const rows = z.array(EvidenceRowSchema).parse(this.db.prepare(
      "SELECT id, content_id, selection_handle, kind, entity_json, entity_hash, index_text_hash FROM authoring_evidence WHERE content_id = ? AND selection_handle = ? ORDER BY created_at, kind",
    ).all(contentId, handle));
    return rows.map((row) => FixedEvidenceSchema.parse(JSON.parse(row.entity_json) as unknown));
  }

  private fromSelection(selection: SelectionView): FixedEvidence[] {
    const evidenceId = randomUUID();
    if (selection.fact !== null) {
      const version = selection.fact.currentVersion;
      const indexText = {
        text: version.indexText,
        codePoints: Array.from(version.indexText).length,
        textHash: sha256(version.indexText),
      };
      const entity = {
        factId: selection.fact.id,
        factVersionId: version.id,
        statement: version.indexText,
        value: version.value,
        unit: version.unit,
        period: version.period,
        merchantId: version.merchantId,
        factKind: version.kind,
        sourceVersionIds: [version.sourceVersionId],
        sourceLocators: [version.sourceLocator],
        indexText,
        entityHash: sha256(canonical({
          factId: selection.fact.id,
          factVersionId: version.id,
          value: version.value,
          unit: version.unit,
          merchantId: version.merchantId,
          period: version.period,
          kind: version.kind,
          sourceVersionIds: [version.sourceVersionId],
          sourceLocators: [version.sourceLocator],
        })),
        indexTextHash: indexText.textHash,
        sourceEntity: selection.fact,
      };
      return [FixedEvidenceSchema.parse({
        kind: "fact",
        evidenceId,
        selectionHandle: selection.id,
        indexGenerationId: selection.indexGenerationId,
        entity,
        source: [],
        entityHash: entity.entityHash,
        indexTextHash: indexText.textHash,
      })];
    }
    if (selection.sourceVersionId === null) {
      throw new ApiError({
        statusCode: 422,
        code: "UNKNOWN_REFERENCE",
        message: "检索选择缺少来源版本",
      });
    }
    const blocks = selection.blocks;
    const media = selection.occurrenceId === null ? null : this.mediaEvidence(selection);
    if (blocks.length === 0 && media !== null) return [media];
    const chunks: ChunkEntity[] = blocks.map((block) => {
      const text = block.text;
      return {
        chunkId: block.id,
        refType: "chunk" as const,
        refId: selection.chunkId,
        sourceVersionId: selection.sourceVersionId!,
        occurrenceId: selection.occurrenceId,
        blockIds: [block.id],
        locators: [block.locator],
        fullText: text,
        indexText: {
          text,
          codePoints: Array.from(text).length,
          textHash: sha256(text),
        },
      };
    });
    if (chunks.length === 0) {
      const row = this.db.prepare(
        "SELECT id, text FROM chunks WHERE id = ? AND source_version_id = ? AND ref_type = 'chunk'",
      ).get(selection.chunkId, selection.sourceVersionId);
      const chunk = z.strictObject({ id: z.uuid(), text: z.string().min(1) }).safeParse(row);
      if (!chunk.success || selection.locators.length === 0) {
        throw new ApiError({
          statusCode: 422,
          code: "UNKNOWN_REFERENCE",
          message: "检索选择缺少可追溯的内容或定位",
        });
      }
      chunks.push({
        chunkId: chunk.data.id,
        refType: "chunk",
        refId: chunk.data.id,
        sourceVersionId: selection.sourceVersionId,
        occurrenceId: selection.occurrenceId,
        blockIds: [],
        locators: selection.locators,
        fullText: chunk.data.text,
        indexText: {
          text: chunk.data.text,
          codePoints: Array.from(chunk.data.text).length,
          textHash: sha256(chunk.data.text),
        },
      });
    }
    const exactText = chunks.map((chunk) => chunk.fullText).join("\n\n");
    const entityHash = sha256(canonical({
      sourceVersionId: selection.sourceVersionId,
      chunkIds: chunks.map((chunk) => chunk.chunkId),
      blockIds: chunks.flatMap((chunk) => chunk.blockIds),
      locators: chunks.flatMap((chunk) => chunk.locators),
      exactText,
    }));
    const sourceEvidence = FixedEvidenceSchema.parse({
      kind: "source",
      evidenceId,
      selectionHandle: selection.id,
      indexGenerationId: selection.indexGenerationId,
      refType: "chunk",
      refId: selection.refId,
      sourceVersionId: selection.sourceVersionId,
      occurrence: null,
      chunks,
      exactText,
      entityHash,
      indexTextHash: sha256(exactText),
    });
    return media === null ? [sourceEvidence] : [sourceEvidence, media];
  }

  private mediaEvidence(selection: SelectionView): FixedEvidence | null {
    const occurrence = this.db.prepare(
      `SELECT o.id, o.source_version_id, o.asset_id, o.locator_json, o.canonical_id, o.version,
              a.blob_hash, a.media_kind
       FROM occurrences o JOIN assets a ON a.id = o.asset_id WHERE o.id = ?`,
    ).get(selection.occurrenceId);
    if (occurrence === undefined) return null;
    const parsed = z.strictObject({
      id: z.uuid(),
      source_version_id: z.uuid(),
      asset_id: z.uuid(),
      locator_json: z.string(),
      canonical_id: z.uuid().nullable(),
      version: z.int(),
      blob_hash: z.string(),
      media_kind: z.enum(["image", "gif", "video"]),
    }).parse(occurrence);
    const version = z.strictObject({ id: z.uuid() }).parse(this.db.prepare(
      "SELECT id FROM asset_versions WHERE asset_id = ? ORDER BY version DESC LIMIT 1",
    ).get(parsed.asset_id));
    const derivative = this.db.prepare(
      "SELECT id, blob_hash, recipe_hash FROM derivatives WHERE asset_id = ? AND kind = 'poster' AND status = 'ready' ORDER BY created_at DESC LIMIT 1",
    ).get(parsed.asset_id);
    const fixedDerivative = derivative === undefined ? null : z.strictObject({
      id: z.uuid(),
      blob_hash: z.string(),
      recipe_hash: z.string(),
    }).parse(derivative);
    return FixedEvidenceSchema.parse({
      kind: "media",
      evidenceId: randomUUID(),
      selectionHandle: selection.id,
      assetVersionId: version.id,
      assetId: parsed.asset_id,
      mediaKind: parsed.media_kind,
      blobHash: parsed.blob_hash,
      occurrence: {
        requestedOccurrenceId: parsed.id,
        canonicalOccurrenceId: parsed.canonical_id ?? parsed.id,
        observedVersion: parsed.version,
        sourceVersionId: parsed.source_version_id,
        locator: JSON.parse(parsed.locator_json) as unknown,
        assetIdAtCapture: parsed.asset_id,
        relationHash: sha256(canonical({
          requestedOccurrenceId: parsed.id,
          canonicalOccurrenceId: parsed.canonical_id ?? parsed.id,
          observedVersion: parsed.version,
          sourceVersionId: parsed.source_version_id,
          locator: JSON.parse(parsed.locator_json) as unknown,
          assetIdAtCapture: parsed.asset_id,
        })),
      },
      derivative: fixedDerivative === null ? null : {
        id: fixedDerivative.id,
        blobHash: fixedDerivative.blob_hash,
        recipeHash: fixedDerivative.recipe_hash,
      },
      segment: null,
      poster: fixedDerivative === null ? null : {
        id: fixedDerivative.id,
        blobHash: fixedDerivative.blob_hash,
      },
    });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
