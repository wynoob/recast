import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  BriefInputSchema,
  BriefSchema,
  ContentDetailSchema,
  ContentSummarySchema,
  ContentKindSchema,
  CreateContentRequestSchema,
  RevisionRecordSchema,
  UpdateContentRequestSchema,
  UtcTimeSchema,
  type Brief,
  type ContentDetail,
  type ContentKind,
  type ContentSummary,
  type CreateContentRequest,
  type UpdateContentRequest,
} from "@dmall/contracts";
import {
  createBrief,
  createEmptyAst,
} from "@dmall/domain";
import { ApiError } from "./errors.js";
import type { IdempotencyRepository } from "./idempotency.js";
import { commitRevision } from "./authoring/revision-commit.js";

const ContentRowSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  brief_json: z.string(),
  merchant_id: z.string().nullable(),
  status: z.enum(["draft", "ready", "archived"]),
  version: z.int().nonnegative(),
  created_at: UtcTimeSchema,
  updated_at: UtcTimeSchema,
});

const ContentListRowSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  status: z.enum(["draft", "ready", "archived"]),
  version: z.int().nonnegative(),
  created_at: UtcTimeSchema,
  updated_at: UtcTimeSchema,
});

const RenditionRowSchema = z.strictObject({
  id: z.uuid(),
  kind: ContentKindSchema,
  label: z.string(),
  root_node_id: z.uuid(),
  current_revision_id: z.uuid(),
  derived_from_revision_id: z.uuid().nullable(),
});

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

const ConversationRowSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  message_count: z.int().nonnegative(),
  created_at: UtcTimeSchema,
});

const CountRowSchema = z.strictObject({ count: z.int().nonnegative() });

export interface CreateContentOptions {
  routeScope: string;
  key: string;
  requestHash: string;
  requestId: string;
}

export class ContentRepository {
  private readonly db: Database.Database;
  private readonly idempotency: IdempotencyRepository;

  constructor(db: Database.Database, idempotency: IdempotencyRepository) {
    this.db = db;
    this.idempotency = idempotency;
  }

  list(input: { q?: string; kind?: ContentKind; limit: number; offset: number }): {
    items: ContentSummary[];
    total: number;
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.q !== undefined && input.q.trim() !== "") {
      clauses.push("c.title LIKE ?");
      params.push(`%${input.q.trim()}%`);
    }
    if (input.kind !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM renditions r WHERE r.content_id = c.id AND r.kind = ?)",
      );
      params.push(input.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = CountRowSchema.parse(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM contents c ${where}`)
        .get(...params),
    ).count;
    const rows = z.array(ContentListRowSchema).parse(
      this.db
        .prepare(
          `SELECT c.id, c.title, c.status, c.version, c.created_at, c.updated_at
           FROM contents c ${where}
           ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, input.limit, input.offset),
    );
    return {
      items: rows.map((row) => this.summary(row)),
      total,
    };
  }

  getById(id: string): ContentDetail {
    const row = this.db
      .prepare(
        `SELECT id, title, brief_json, merchant_id, status, version, created_at, updated_at
         FROM contents WHERE id = ?`,
      )
      .get(id);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "内容不存在" });
    }
    const content = ContentRowSchema.parse(row);
    const renditions = z.array(RenditionRowSchema).parse(
      this.db
        .prepare(
          `SELECT id, kind, label, root_node_id, current_revision_id, derived_from_revision_id
           FROM renditions WHERE content_id = ? ORDER BY created_at, id`,
        )
        .all(content.id),
    );
    const revisions = renditions.map((rendition) => {
      const revisionRow = this.db
        .prepare(
          `SELECT id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at
           FROM revisions WHERE id = ?`,
        )
        .get(rendition.current_revision_id);
      if (revisionRow === undefined) {
        throw new ApiError({
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: "内容当前版本缺失",
        });
      }
      const revision = RevisionRowSchema.parse(revisionRow);
      return RevisionRecordSchema.parse({
        schemaVersion: 1,
        id: revision.id,
        renditionId: revision.rendition_id,
        parentId: revision.parent_id,
        templateVersionId: revision.template_version_id,
        ast: JSON.parse(revision.ast_json) as unknown,
        createdBy: revision.created_by,
        reason: revision.reason,
        createdAt: revision.created_at,
      });
    });
    const conversations = z.array(ConversationRowSchema).parse(
      this.db
        .prepare(
          `SELECT c.id, c.title, c.created_at, COUNT(m.id) AS message_count
           FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
           WHERE c.content_id = ? GROUP BY c.id ORDER BY c.updated_at DESC`,
        )
        .all(content.id),
    );
    return ContentDetailSchema.parse({
      ...this.summary(content),
      brief: BriefSchema.parse(JSON.parse(content.brief_json) as unknown),
      renditions: renditions.map((rendition, index) => ({
        id: rendition.id,
        kind: rendition.kind,
        label: rendition.label,
        rootNodeId: rendition.root_node_id,
        currentRevisionId: rendition.current_revision_id,
        derivedFromRevisionId: rendition.derived_from_revision_id,
        revision: revisions[index],
      })),
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        messageCount: conversation.message_count,
        createdAt: conversation.created_at,
      })),
    });
  }

  create(input: CreateContentRequest, options: CreateContentOptions): ContentDetail {
    const now = new Date().toISOString();
    const contentId = randomUUID();
    const renditionId = randomUUID();
    const rootNodeId = randomUUID();
    const conversationId = randomUUID();
    const brief = createBrief(
      BriefInputSchema.parse(input.brief ?? emptyBriefInput()),
      { contentId, kind: input.kind },
    );
    const ast = createEmptyAst({ kind: input.kind, title: input.title });

    const transaction = this.db.transaction((): { detail: ContentDetail; response: unknown } => {
      this.db
        .prepare(
          `INSERT INTO contents
            (id, title, brief_json, merchant_id, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', 0, ?, ?)`,
        )
        .run(contentId, input.title, JSON.stringify(brief), brief.merchantId, now, now);
      this.db
        .prepare(
          `INSERT INTO renditions
            (id, content_id, kind, label, root_node_id, current_revision_id, derived_from_revision_id, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
        )
        .run(renditionId, contentId, input.kind, "主版本", rootNodeId, now, now);
      commitRevision(this.db, {
        mode: "first_revision",
        contentId,
        renditionId,
        rootNodeId,
        ast,
        templateVersionId: null,
        createdBy: "user",
        reason: "创建空白内容",
        expectedCurrentRevisionId: null,
      });
      this.db
        .prepare(
          "INSERT INTO conversations (id, content_id, title, created_at, updated_at) VALUES (?, ?, '创作会话', ?, ?)",
        )
        .run(conversationId, contentId, now, now);
      const detail = this.getById(contentId);
      const response = { data: detail, requestId: options.requestId };
      this.idempotency.save({
        routeScope: options.routeScope,
        key: options.key,
        requestHash: options.requestHash,
        statusCode: 201,
        requestId: options.requestId,
        response,
        resultRef: contentId,
      });
      return { detail, response };
    });

    return transaction.immediate().detail;
  }

  update(input: {
    id: string;
    request: UpdateContentRequest;
    options: CreateContentOptions;
  }): ContentDetail {
    const transaction = this.db.transaction((): ContentDetail => {
      const existing = this.getById(input.id);
      if (existing.version !== input.request.expectedVersion) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "内容已被其他操作修改，请重新打开后再保存",
          details: { currentVersion: existing.version },
        });
      }
      const title = input.request.title ?? existing.title;
      const briefInput = input.request.brief ?? {
        goal: existing.brief.goal,
        audience: existing.brief.audience,
        merchantId: existing.brief.merchantId,
        durationMinutes: existing.brief.durationMinutes,
        userOutline: existing.brief.userOutline,
        mustKeepOutline: existing.brief.mustKeepOutline,
        tone: existing.brief.tone,
        sourceScope: existing.brief.sourceScope,
        unresolvedQuestions: existing.brief.unresolvedQuestions,
      };
      const brief = createBrief(BriefInputSchema.parse(briefInput), {
        contentId: existing.id,
        kind: existing.kinds[0] ?? "feishu_doc",
      });
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE contents SET title = ?, brief_json = ?, merchant_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(title, JSON.stringify(brief), brief.merchantId, now, input.id, input.request.expectedVersion);
      const detail = this.getById(input.id);
      const response = { data: detail, requestId: input.options.requestId };
      this.idempotency.save({
        routeScope: input.options.routeScope,
        key: input.options.key,
        requestHash: input.options.requestHash,
        statusCode: 200,
        requestId: input.options.requestId,
        response,
        resultRef: input.id,
      });
      return detail;
    });
    return transaction();
  }

  private summary(row: z.infer<typeof ContentListRowSchema> | z.infer<typeof ContentRowSchema>): ContentSummary {
    const kinds = z.array(ContentKindSchema).parse(
      this.db
        .prepare("SELECT kind FROM renditions WHERE content_id = ? ORDER BY created_at, kind")
        .all(row.id)
        .map((item) => z.strictObject({ kind: ContentKindSchema }).parse(item).kind),
    );
    return ContentSummarySchema.parse({
      id: row.id,
      title: row.title,
      status: row.status,
      version: row.version,
      kinds,
      renditionCount: kinds.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

export function emptyBriefInput(): z.infer<typeof BriefInputSchema> {
  return {
    goal: "",
    audience: [],
    merchantId: null,
    durationMinutes: null,
    userOutline: [],
    mustKeepOutline: false,
    tone: "",
    sourceScope: { sourceVersionIds: [], excludeIds: [] },
    unresolvedQuestions: [],
  };
}

export function parseCreateContent(input: unknown): CreateContentRequest {
  return CreateContentRequestSchema.parse(input);
}

export function parseUpdateContent(input: unknown): UpdateContentRequest {
  return UpdateContentRequestSchema.parse(input);
}

export function briefTargetKind(brief: Brief): ContentKind {
  return brief.targetKind;
}
