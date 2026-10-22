import type Database from "better-sqlite3";
import { z } from "zod";
import {
  RevisionEvidenceSchema,
  RevisionListItemSchema,
  RevisionRefSchema,
  RevisionViewSchema,
  FixedEvidenceSchema,
  UtcTimeSchema,
  type ManualRevisionRequest,
  type RestoreRevisionRequest,
  type RevisionEvidence,
  type RevisionList,
  type RevisionRef,
  type RevisionView,
  type FixedEvidence,
} from "@dmall/contracts";
import { deriveRevisionRefs } from "@dmall/domain";
import { ApiError } from "../errors.js";
import type { IdempotencyRecord, IdempotencyRepository } from "../idempotency.js";
import {
  commitRevision,
  RevisionCommitError,
  parseRevisionAst,
  sha256,
  stableJson,
} from "./revision-commit.js";

const RevisionRowSchema = z.strictObject({
  id: z.uuid(),
  rendition_id: z.uuid(),
  parent_id: z.uuid().nullable(),
  template_version_id: z.uuid().nullable(),
  ast_json: z.string(),
  created_by: z.enum(["user", "ai_accepted", "feishu_pull", "restore", "import"]),
  reason: z.string(),
  created_at: UtcTimeSchema,
});

const EvidenceRowSchema = z.strictObject({
  revision_id: z.uuid(),
  schema_version: z.int(),
  direct_refs_json: z.string(),
  transitive_refs_json: z.string(),
  blob_hashes_json: z.string(),
  bindings_json: z.string(),
  binding_hash: z.string(),
  created_at: UtcTimeSchema,
});

const RefRowSchema = z.strictObject({
  ref_type: z.enum([
    "source_version",
    "fact_version",
    "message",
    "asset_version",
    "occurrence",
    "derivative",
    "segment",
    "template_version",
  ]),
  ref_id: z.uuid(),
});

const RenditionRowSchema = z.strictObject({
  id: z.uuid(),
  current_revision_id: z.uuid().nullable(),
});

const CountRowSchema = z.strictObject({ count: z.int().nonnegative() });
const IdRowSchema = z.strictObject({ id: z.uuid() });
const OccurrenceStateRowSchema = z.strictObject({
  id: z.uuid(),
  asset_id: z.uuid().nullable(),
});
const AssetVersionStateRowSchema = z.strictObject({
  id: z.uuid(),
  blob_hash: z.string(),
});
const DerivativeStateRowSchema = z.strictObject({
  id: z.uuid(),
  blob_hash: z.string(),
});
const SegmentStateRowSchema = z.strictObject({ id: z.uuid() });
const MessageStateRowSchema = z.strictObject({ id: z.uuid() });

export type ApiReply = {
  readonly statusCode: number;
  readonly response: unknown;
};

export class RevisionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly idempotency: IdempotencyRepository,
  ) {}

  saveManual(input: {
    readonly renditionId: string;
    readonly request: ManualRevisionRequest;
    readonly routeScope: string;
    readonly key: string;
    readonly requestHash: string;
    readonly requestId: string;
  }): ApiReply {
    return this.writeTransaction(() => {
      const replay = this.replay(input.routeScope, input.key, input.requestHash);
      if (replay !== null) return replay;
      const result = commitRevision(this.db, {
        mode: "manual",
        renditionId: input.renditionId,
        baseRevisionId: input.request.baseRevisionId,
        operations: input.request.operations,
        claims: input.request.claims,
        evidenceSelections: input.request.evidenceSelections,
        fixedEvidence: this.fixedEvidence(input.renditionId, input.request.evidenceSelections),
        createdBy: "user",
        expectedCurrentRevisionId: input.request.baseRevisionId,
        reason: "人工保存修订",
      });
      const view = this.viewById(result.revisionId);
      const response = { data: view, requestId: input.requestId };
      this.idempotency.save({
        routeScope: input.routeScope,
        key: input.key,
        requestHash: input.requestHash,
        statusCode: 201,
        requestId: input.requestId,
        response,
        resultRef: view.id,
      });
      return { statusCode: 201, response };
    });
  }

  restore(input: {
    readonly renditionId: string;
    readonly request: RestoreRevisionRequest;
    readonly routeScope: string;
    readonly key: string;
    readonly requestHash: string;
    readonly requestId: string;
  }): ApiReply {
    return this.writeTransaction(() => {
      const replay = this.replay(input.routeScope, input.key, input.requestHash);
      if (replay !== null) return replay;
      const result = commitRevision(this.db, {
        mode: "restore",
        renditionId: input.renditionId,
        historicalRevisionId: input.request.historicalRevisionId,
        createdBy: "restore",
        expectedCurrentRevisionId: input.request.expectedRevisionId,
        reason: `恢复到修订 ${input.request.historicalRevisionId}`,
      });
      const view = this.viewById(result.revisionId);
      const response = { data: view, requestId: input.requestId };
      this.idempotency.save({
        routeScope: input.routeScope,
        key: input.key,
        requestHash: input.requestHash,
        statusCode: 201,
        requestId: input.requestId,
        response,
        resultRef: view.id,
      });
      return { statusCode: 201, response };
    });
  }

  list(input: {
    readonly renditionId: string;
    readonly limit: number;
    readonly offset: number;
    readonly revisionId?: string;
  }): RevisionList | RevisionView {
    this.requireRendition(input.renditionId);
    if (input.revisionId !== undefined) {
      const view = this.viewById(input.revisionId);
      if (view.renditionId !== input.renditionId) {
        throw new ApiError({
          statusCode: 404,
          code: "NOT_FOUND",
          message: "修订不属于该稿件分支",
        });
      }
      return view;
    }
    const total = CountRowSchema.parse(
      this.db.prepare("SELECT COUNT(*) AS count FROM revisions WHERE rendition_id = ?")
        .get(input.renditionId),
    ).count;
    const rows = z.array(RevisionRowSchema).parse(
      this.db.prepare(
        `SELECT id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at
         FROM revisions WHERE rendition_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).all(input.renditionId, input.limit, input.offset),
    );
    return {
      items: rows.map((row) => {
        const evidence = this.readEvidence(row.id);
        return RevisionListItemSchema.parse({
          id: row.id,
          renditionId: row.rendition_id,
          parentId: row.parent_id,
          templateVersionId: row.template_version_id,
          createdBy: row.created_by,
          reason: row.reason,
          createdAt: row.created_at,
          evidenceHash: evidence.evidence?.bindingHash ?? null,
          evidenceState: evidence.state,
        });
      }),
      nextCursor:
        input.offset + rows.length < total ? String(input.offset + input.limit) : null,
      total,
    };
  }

  viewById(revisionId: string): RevisionView {
    const row = this.requireRevisionRow(revisionId);
    const evidence = this.readEvidence(row.id);
    const refs = this.readRefs(row.id);
    const checkedAt = new Date().toISOString();
    return RevisionViewSchema.parse({
      schemaVersion: 1,
      id: row.id,
      renditionId: row.rendition_id,
      parentId: row.parent_id,
      templateVersionId: row.template_version_id,
      ast: parseRevisionAst(JSON.parse(row.ast_json) as unknown),
      createdBy: row.created_by,
      reason: row.reason,
      createdAt: row.created_at,
      evidenceHash: evidence.evidence?.bindingHash ?? null,
      evidence: evidence.view,
      references: refs.map((ref) => ({
        ref,
        state: this.referenceState(ref, checkedAt),
      })),
    });
  }

  private writeTransaction<T>(work: () => T): T {
    try {
      return this.db.transaction(work).immediate();
    } catch (error) {
      if (isDiskFull(error)) {
        throw new ApiError({
          statusCode: 507,
          code: "DISK_FULL",
          message: "磁盘空间不足，修订未保存",
          retryable: true,
        });
      }
      if (error instanceof RevisionCommitError) {
        throw this.toApiError(error);
      }
      throw error;
    }
  }

  private toApiError(error: RevisionCommitError): ApiError {
    const details = { ...error.details };
    if (error.code === "REVISION_CONFLICT") {
      const currentRevisionId = error.details.currentRevisionId;
      if (typeof currentRevisionId === "string") {
        details.currentRevision = this.viewById(currentRevisionId);
      }
    }
    return new ApiError({
      statusCode: error.code === "REVISION_CONFLICT" || error.code === "LOCKED_FIELD" ? 409 : 422,
      code: error.code,
      message: error.message,
      details,
    });
  }

  private replay(routeScope: string, key: string, requestHash: string): ApiReply | null {
    const existing: IdempotencyRecord | null = this.idempotency.find(routeScope, key);
    if (existing === null) return null;
    if (existing.requestHash !== requestHash) {
      throw new ApiError({
        statusCode: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "同一 Idempotency-Key 对应了不同请求",
      });
    }
    return { statusCode: existing.statusCode, response: existing.response };
  }

  private requireRendition(renditionId: string): z.infer<typeof RenditionRowSchema> {
    const row = this.db.prepare(
      "SELECT id, current_revision_id FROM renditions WHERE id = ?",
    ).get(renditionId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "稿件分支不存在" });
    }
    return RenditionRowSchema.parse(row);
  }

  private fixedEvidence(renditionId: string, ids: readonly string[]): FixedEvidence[] {
    if (ids.length === 0) return [];
    const contentId = z.strictObject({ content_id: z.uuid() }).parse(
      this.db.prepare("SELECT content_id FROM renditions WHERE id = ?").get(renditionId),
    ).content_id;
    const rows = ids.map((id) => {
      const row = this.db.prepare(
        "SELECT entity_json FROM authoring_evidence WHERE id = ? AND content_id = ?",
      ).get(id, contentId);
      if (row === undefined) {
        throw new ApiError({
          statusCode: 422,
          code: "UNKNOWN_REFERENCE",
          message: "证据选择不存在或不属于该内容",
          details: { evidenceId: id },
        });
      }
      return z.strictObject({ entity_json: z.string() }).parse(row).entity_json;
    });
    return rows.map((json) => FixedEvidenceSchema.parse(JSON.parse(json) as unknown));
  }

  private requireRevisionRow(revisionId: string): z.infer<typeof RevisionRowSchema> {
    const row = this.db.prepare(
      `SELECT id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at
       FROM revisions WHERE id = ?`,
    ).get(revisionId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "修订不存在" });
    }
    return RevisionRowSchema.parse(row);
  }

  private readEvidence(revisionId: string): {
    state: "resolved" | "unresolved" | "empty";
    evidence: RevisionEvidence | null;
    view: RevisionView["evidence"];
  } {
    const row = this.db.prepare(
      `SELECT revision_id, schema_version, direct_refs_json, transitive_refs_json,
              blob_hashes_json, bindings_json, binding_hash, created_at
       FROM revision_evidence WHERE revision_id = ?`,
    ).get(revisionId);
    if (row !== undefined) {
      const parsed = EvidenceRowSchema.parse(row);
      const evidence = RevisionEvidenceSchema.parse({
        schemaVersion: parsed.schema_version,
        directRefs: JSON.parse(parsed.direct_refs_json) as unknown,
        transitiveRefs: JSON.parse(parsed.transitive_refs_json) as unknown,
        blobHashes: JSON.parse(parsed.blob_hashes_json) as unknown,
        bindings: JSON.parse(parsed.bindings_json) as unknown,
        bindingHash: parsed.binding_hash,
      });
      const state = evidence.directRefs.length === 0 && evidence.bindings.length === 0
        ? "empty"
        : "resolved";
      return { state, evidence, view: { kind: state, evidence } };
    }

    const revision = this.requireRevisionRow(revisionId);
    const ast = parseRevisionAst(JSON.parse(revision.ast_json) as unknown);
    if (deriveRevisionRefs({ ast, templateVersionId: revision.template_version_id }).length > 0) {
      return {
        state: "unresolved",
        evidence: null,
        view: { kind: "unresolved", reason: "REFERENCE_HISTORY_UNRESOLVED" },
      };
    }
    const evidence = emptyEvidence();
    return { state: "empty", evidence, view: { kind: "empty", evidence } };
  }

  private readRefs(revisionId: string): RevisionRef[] {
    return z.array(RefRowSchema).parse(
      this.db.prepare(
        "SELECT ref_type, ref_id FROM revision_refs WHERE revision_id = ? ORDER BY ref_type, ref_id",
      ).all(revisionId),
    ).map((row) => RevisionRefSchema.parse({ refType: row.ref_type, refId: row.ref_id }));
  }

  private referenceState(
    ref: RevisionRef,
    checkedAt: string,
  ): RevisionView["references"][number]["state"] {
    const sqlByType: Record<RevisionRef["refType"], string | null> = {
      source_version: "SELECT id FROM source_versions WHERE id = ?",
      fact_version: "SELECT id FROM fact_versions WHERE id = ?",
      message: "SELECT id FROM messages WHERE id = ?",
      asset_version: `SELECT av.id, a.blob_hash FROM asset_versions av
                      JOIN assets a ON a.id = av.asset_id WHERE av.id = ?`,
      occurrence: "SELECT id, asset_id FROM occurrences WHERE id = ?",
      derivative: "SELECT id, blob_hash FROM derivatives WHERE id = ?",
      segment: "SELECT id FROM segments WHERE id = ?",
      template_version: "SELECT id FROM template_versions WHERE id = ?",
    };
    const sql = sqlByType[ref.refType];
    if (sql === null) return { kind: "missing", reason: "UNSUPPORTED_REFERENCE_TYPE" };
    const row = this.db.prepare(sql).get(ref.refId);
    if (row === undefined) return { kind: "missing", reason: "REFERENCE_ROW_MISSING" };
    if (ref.refType === "occurrence") {
      const occurrence = OccurrenceStateRowSchema.parse(row);
      if (occurrence.asset_id === null) {
        return { kind: "missing", reason: "OCCURRENCE_ASSET_MISSING" };
      }
      const asset = this.db.prepare(
        "SELECT id, blob_hash FROM assets WHERE id = ?",
      ).get(occurrence.asset_id);
      if (asset === undefined) return { kind: "missing", reason: "ASSET_ROW_MISSING" };
    }
    if (ref.refType === "occurrence") {
      OccurrenceStateRowSchema.parse(row);
    } else if (ref.refType === "asset_version") {
      AssetVersionStateRowSchema.parse(row);
    } else if (ref.refType === "derivative") {
      DerivativeStateRowSchema.parse(row);
    } else if (ref.refType === "segment") {
      SegmentStateRowSchema.parse(row);
    } else if (ref.refType === "message") {
      MessageStateRowSchema.parse(row);
    } else {
      IdRowSchema.parse(row);
    }
    return { kind: "available", checkedAt };
  }
}

function emptyEvidence(): RevisionEvidence {
  const base = {
    schemaVersion: 1 as const,
    directRefs: [],
    transitiveRefs: [],
    blobHashes: [],
    bindings: [],
  };
  return RevisionEvidenceSchema.parse({ ...base, bindingHash: sha256(stableJson(base)) });
}

function isDiskFull(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "code" in error && error.code === "SQLITE_FULL";
}
