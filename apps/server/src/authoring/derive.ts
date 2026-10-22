import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  DeriveRenditionRequestSchema,
  DeriveRenditionResultSchema,
  type DeriveRenditionRequest,
  type DeriveRenditionResult,
} from "@dmall/contracts";
import { createEmptyAst } from "@dmall/domain";
import type { ContentRepository } from "../content-repository.js";
import { ApiError } from "../errors.js";
import { PlanService } from "./plans.js";
import { commitRevision } from "./revision-commit.js";

const SourceRowSchema = z.strictObject({
  revision_id: z.uuid(),
  rendition_id: z.uuid(),
  content_id: z.uuid(),
  kind: z.enum(["feishu_doc", "html_deck"]),
  title: z.string(),
});

export class DeriveService {
  private readonly plans: PlanService;

  constructor(
    private readonly db: Database.Database,
    private readonly contents: ContentRepository,
    plans?: PlanService,
  ) {
    this.plans = plans ?? new PlanService(db);
  }

  derive(contentId: string, request: DeriveRenditionRequest): DeriveRenditionResult {
    const input = DeriveRenditionRequestSchema.parse(request);
    const result = this.db.transaction(() => {
      const source = this.source(contentId, input.fromRevisionId);
      if (input.confirmationId !== null) {
        const confirmation = this.plans.getConfirmation(input.confirmationId);
        if (confirmation.contentId !== contentId) {
          throw new ApiError({
            statusCode: 422,
            code: "UNKNOWN_REFERENCE",
            message: "派生引用的需求确认不属于该内容",
          });
        }
      }
      const renditionId = randomUUID();
      const rootNodeId = randomUUID();
      const now = new Date().toISOString();
      const label = this.uniqueLabel(contentId, input.label);
      this.db.prepare(
        `INSERT INTO renditions(
          id, content_id, kind, label, root_node_id, current_revision_id,
          derived_from_revision_id, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
      ).run(
        renditionId,
        contentId,
        input.targetKind,
        label,
        rootNodeId,
        source.revision_id,
        now,
        now,
      );
      const ast = createEmptyAst({ kind: input.targetKind, title: source.title });
      const revision = commitRevision(this.db, {
        mode: "derive_initial",
        contentId,
        renditionId,
        rootNodeId,
        ast,
        templateVersionId: null,
        createdBy: "user",
        expectedCurrentRevisionId: null,
        reason: `从修订 ${source.revision_id} 派生 ${input.targetKind}`,
      });
      return {
        contentId,
        renditionId,
        revisionId: revision.revisionId,
      };
    }).immediate();
    return DeriveRenditionResultSchema.parse({
      content: this.contents.getById(result.contentId),
      renditionId: result.renditionId,
      revisionId: result.revisionId,
    });
  }

  private source(contentId: string, revisionId: string): z.infer<typeof SourceRowSchema> {
    const row = this.db.prepare(
      `SELECT r.id AS revision_id, r.rendition_id, d.content_id, d.kind, c.title
       FROM revisions r
       JOIN renditions d ON d.id = r.rendition_id
       JOIN contents c ON c.id = d.content_id
       WHERE r.id = ? AND d.content_id = ?`,
    ).get(revisionId, contentId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "源修订不存在" });
    }
    return SourceRowSchema.parse(row);
  }

  private uniqueLabel(contentId: string, requested: string): string {
    const labels = new Set(
      z.array(z.strictObject({ label: z.string() })).parse(
        this.db.prepare("SELECT label FROM renditions WHERE content_id = ?").all(contentId),
      ).map((item) => item.label),
    );
    if (!labels.has(requested)) return requested;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${requested} ${index}`;
      if (!labels.has(candidate)) return candidate;
    }
    throw new ApiError({ statusCode: 409, code: "VALIDATION_ERROR", message: "派生版本名称过多" });
  }
}
