import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AcceptPullRequestSchema,
  CreateExportRequestSchema,
  ExportListSchema,
  ExportRecordSchema,
  ExportStatusSchema,
  JobInputSchema,
  AstSchema,
  OutputDecisionSchema,
  OutputPreviewSchema,
  ProjectBundleImportRequestSchema,
  PullRequestSchema,
  type ExportArtifact,
  type ExportList,
  type ExportRecord,
  type ExportWarning,
  type JobGrant,
  type JobResult,
  type OutputDecision,
  type PullRecord,
} from "@dmall/contracts";
import { deriveRevisionRefs } from "@dmall/domain";
import type { BlobStore } from "@dmall/storage";
import { ApiError } from "../errors.js";
import { insertRevisionRecord } from "../authoring/revision-commit.js";
import type { IdempotencyRepository } from "../idempotency.js";
import type { JobRepository } from "../job-repository.js";
import { loadRevisionOutputSource } from "./media-plan.js";
import { OutputMediaPlanner } from "./media-plan.js";
import { loadOutputTemplate } from "./template-source.js";
import { buildProjectBundlePlan } from "./bundle-builder.js";
import { applyProjectBundleImport } from "./bundle-import.js";
import type { ImportRepository } from "../import-repository.js";

const ExportJobRowSchema = z.strictObject({
  export_id: z.uuid(),
  job_id: z.uuid(),
  content_id: z.uuid(),
  rendition_id: z.uuid(),
  revision_id: z.uuid(),
  format: z.enum(["html_zip", "pdf", "project_bundle", "feishu_doc"]),
  speaker_notes: z.int().min(0).max(1),
  renderer_version: z.string(),
  title: z.string(),
  media_summary_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ExportRowSchema = z.strictObject({
  id: z.uuid(),
  rendition_id: z.uuid(),
  revision_id: z.uuid(),
  format: z.enum(["html_zip", "pdf", "project_bundle", "feishu_doc"]),
  options_json: z.string(),
  status: z.string(),
  output_blob_hash: z.string().nullable(),
  warning_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ArtifactRowSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["html_zip", "pdf", "project_bundle", "feishu_receipt", "preview"]),
  file_name: z.string(),
  mime: z.string(),
  bytes: z.int().nonnegative(),
  sha256: z.string(),
  storage_relative_path: z.string(),
  created_at: z.string(),
});

const ImportRowSchema = z.strictObject({
  id: z.uuid(),
  job_id: z.uuid(),
  bundle_sha256: z.string(),
  bundle_relative_path: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  original_title: z.string().nullable(),
  content_id: z.uuid().nullable(),
  rendition_id: z.uuid().nullable(),
  revision_id: z.uuid().nullable(),
  report_json: z.string().nullable(),
  error_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const PullRowSchema = z.strictObject({
  id: z.uuid(),
  binding_id: z.uuid(),
  job_id: z.uuid(),
  source_version_id: z.uuid().nullable(),
  base_revision_id: z.uuid(),
  observed_current_revision_id: z.uuid(),
  ast_json: z.string().nullable(),
  status: z.enum(["preview", "accepted", "rejected"]),
  accepted_rendition_id: z.uuid().nullable(),
  accepted_revision_id: z.uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const BindingRowSchema = z.strictObject({
  id: z.uuid(),
  rendition_id: z.uuid(),
  exported_revision_id: z.uuid(),
  remote_document_id: z.string(),
  remote_url: z.string(),
  block_map_json: z.string(),
  media_map_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

interface WriteContext {
  routeScope: string;
  key: string;
  requestHash: string;
  requestId: string;
}

function now(): string {
  return new Date().toISOString();
}

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function within(root: string, candidate: string): string {
  const resolved = resolve(candidate);
  const base = resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new ApiError({ statusCode: 422, code: "PATH_NOT_ALLOWED", message: "输出路径越界" });
  }
  return resolved;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return cleaned === "" ? "export.bin" : cleaned.slice(0, 160);
}

function jsonObject(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  const parsed = JSON.parse(value) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function warningsFrom(value: Record<string, unknown>): ExportWarning[] {
  const warnings = value.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const code = "code" in item ? String(item.code) : "";
    const message = "message" in item ? String(item.message) : "";
    return code === "" || message === "" ? [] : [{ code, message }];
  });
}

export class OutputRepository {
  private readonly db: Database.Database;
  private readonly blobs: BlobStore;
  private readonly idempotency: IdempotencyRepository;
  private readonly jobs: JobRepository;
  private readonly dataRoot: string;
  private readonly imports: ImportRepository;
  private readonly planner: OutputMediaPlanner;

  constructor(input: {
    db: Database.Database;
    blobs: BlobStore;
    idempotency: IdempotencyRepository;
    jobs: JobRepository;
    dataRoot: string;
    imports: ImportRepository;
  }) {
    this.db = input.db;
    this.blobs = input.blobs;
    this.idempotency = input.idempotency;
    this.jobs = input.jobs;
    this.dataRoot = resolve(input.dataRoot);
    this.imports = input.imports;
    this.planner = new OutputMediaPlanner(input.db);
    this.jobs.addLocalFinalizer((jobId, state, result) =>
      state === "waiting_input" ? { state, result } : this.finalizeJob(jobId, state, result),
    );
    this.jobs.addWaitingObserver((jobId) => this.markWaiting(jobId));
  }

  hasFeishuCredential(): boolean {
    const token = process.env.DCW_FEISHU_USER_ACCESS_TOKEN?.trim();
    return token !== undefined && token !== "";
  }

  async prepareGrant(grant: JobGrant): Promise<JobGrant> {
    const type = grant.input.jobType;
    if (!["export_output", "project_bundle_import", "feishu_publish", "feishu_pull"].includes(type)) {
      return grant;
    }
    const workspacePath = join(this.dataRoot, "staging", grant.jobId);
    mkdirSync(workspacePath, { recursive: true });
    const decisionRow = this.db.prepare(
      "SELECT decision_json FROM output_job_decisions WHERE job_id = ?",
    ).get(grant.jobId);
    const remoteDecision = decisionRow === undefined
      ? null
      : z.strictObject({ decision_json: z.string() }).parse(decisionRow).decision_json;
    const parsedDecision = remoteDecision === null ? null : JSON.parse(remoteDecision) as unknown;
    return {
      ...grant,
      workspacePath,
      blobRoot: this.dataRoot,
      ...(parsedDecision === null
        ? {}
        : { remoteDecision: OutputDecisionSchema.parse(parsedDecision) }),
    };
  }

  async createExport(requestValue: unknown, context: WriteContext): Promise<{
    statusCode: number;
    response: unknown;
  }> {
    const request = CreateExportRequestSchema.parse(requestValue);
    const revision = loadRevisionOutputSource(this.db, request.revisionId);
    if (revision.renditionId !== request.renditionId) {
      throw new ApiError({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: "修订版本不属于指定稿件分支",
      });
    }
    const rendition = this.requireRendition(request.renditionId);
    if (rendition.content_id !== this.revisionContentId(request.revisionId)) {
      throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "修订与内容不匹配" });
    }
    const content = this.requireContent(rendition.content_id);
    const template = loadOutputTemplate(this.db, revision.templateVersionId, rendition.kind);
    const bundle = request.format === "project_bundle"
      ? await buildProjectBundlePlan({
          db: this.db,
          blobs: this.blobs,
          contentId: rendition.content_id,
          primaryRevisionId: request.revisionId,
          ...(request.options.revisionIds === undefined ? {} : { selectedRevisionIds: request.options.revisionIds }),
        })
      : null;
    return this.db.transaction(() => {
      const replay = this.replay(context);
      if (replay !== null) return replay;
      if (request.format === "feishu_doc") {
        if (!this.hasFeishuCredential()) {
          throw new ApiError({
            statusCode: 409,
            code: "FEISHU_AUTH_MISSING",
            message: "飞书用户凭证未配置，飞书文档输出已阻断；HTML、PDF 和项目包仍可使用",
            retryable: false,
          });
        }
        if (request.options.feishu?.publish !== true || request.options.feishu.confirmedCreateDocument !== true) {
          throw new ApiError({
            statusCode: 422,
            code: "VALIDATION_ERROR",
            message: "生成新的飞书文档需要用户明确确认",
          });
        }
      }
      const title = request.options.title ?? content.title ?? revision.ast.title;
      const exportId = randomUUID();
      const createdAt = now();
      let mediaPlan: ReturnType<OutputMediaPlanner["plan"]> | null = null;
      let jobInput;
      if (request.format === "project_bundle") {
        if (bundle === null) throw new ApiError({ statusCode: 500, code: "INTERNAL_ERROR", message: "项目包计划缺失" });
        jobInput = JobInputSchema.parse({
          schemaVersion: 1,
          jobType: "export_output",
          exportId,
          contentId: rendition.content_id,
          renditionId: rendition.id,
          revisionId: request.revisionId,
          format: "project_bundle",
          title,
          ast: revision.ast,
          templateVersionId: template.templateVersionId,
          templatePackage: template.package,
          options: request.options,
          media: [],
          bundle,
        });
      } else {
        mediaPlan = this.planner.plan(revision.ast);
        if (request.format === "feishu_doc") {
          jobInput = JobInputSchema.parse({
            schemaVersion: 1,
            jobType: "feishu_publish",
            exportId,
            contentId: rendition.content_id,
            renditionId: rendition.id,
            revisionId: request.revisionId,
            title,
            ast: revision.ast,
            templateVersionId: template.templateVersionId,
            templatePackage: template.package,
            options: request.options,
            media: mediaPlan.items,
            folderToken: request.options.feishu?.folderToken ?? null,
          });
        } else {
          jobInput = JobInputSchema.parse({
            schemaVersion: 1,
            jobType: "export_output",
            exportId,
            contentId: rendition.content_id,
            renditionId: rendition.id,
            revisionId: request.revisionId,
            format: request.format,
            title,
            ast: revision.ast,
            templateVersionId: template.templateVersionId,
            templatePackage: template.package,
            options: request.options,
            media: mediaPlan.items,
          });
        }
      }
      const warnings = [
        ...(mediaPlan?.warnings ?? []),
        ...(template.warning === null ? [] : [{ code: "BUILTIN_TEMPLATE_FALLBACK", message: template.warning }]),
      ];
      const mediaSummary = mediaPlan?.summary ?? {
        total: 0,
        images: 0,
        gifs: 0,
        videos: 0,
        missing: [],
        degraded: [],
      };
      this.db.prepare(
        `INSERT INTO exports
          (id, rendition_id, revision_id, format, options_json, status, output_blob_hash,
           warning_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?)`,
      ).run(
        exportId,
        request.renditionId,
        request.revisionId,
        request.format,
        JSON.stringify(request.options),
        JSON.stringify({ warnings }),
        createdAt,
        createdAt,
      );
      const snapshot = this.jobs.create({
        type: request.format === "feishu_doc" ? "feishu_publish" : "export_output",
        input: jobInput,
        inputHash: context.requestHash,
        idempotencyKey: context.key,
      });
      this.db.prepare(
        `INSERT INTO export_jobs
          (export_id, job_id, content_id, rendition_id, revision_id, format,
           speaker_notes, renderer_version, title, media_summary_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        exportId,
        snapshot.id,
        rendition.content_id,
        rendition.id,
        request.revisionId,
        request.format,
        request.options.speakerNotes ? 1 : 0,
        template.package.rendererVersion,
        title,
        JSON.stringify(mediaSummary),
        createdAt,
        createdAt,
      );
      const response = {
        data: {
          schemaVersion: 1,
          jobId: snapshot.id,
          status: "queued",
          exportId,
        },
        requestId: context.requestId,
      };
      this.saveIdempotency(context, 202, response, exportId);
      return { statusCode: 202, response };
    }).immediate();
  }

  list(input: { contentId: string; renditionId?: string; limit: number; offset: number }): ExportList {
    const total = z.strictObject({ count: z.int().nonnegative() }).parse(
      this.db.prepare(
        `SELECT COUNT(*) AS count FROM exports e JOIN export_jobs ej ON ej.export_id = e.id
         WHERE ej.content_id = ? ${input.renditionId === undefined ? "" : "AND e.rendition_id = ?"}`,
      ).get(input.contentId, ...(input.renditionId === undefined ? [] : [input.renditionId])),
    ).count;
    const rows = z.array(z.strictObject({ id: z.uuid() })).parse(
      this.db.prepare(
        `SELECT e.id FROM exports e JOIN export_jobs ej ON ej.export_id = e.id
         WHERE ej.content_id = ? ${input.renditionId === undefined ? "" : "AND e.rendition_id = ?"}
         ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      ).all(input.contentId, ...(input.renditionId === undefined ? [] : [input.renditionId]), input.limit, input.offset),
    );
    return ExportListSchema.parse({
      items: rows.map((row) => this.get(row.id)),
      nextCursor: input.offset + rows.length < total ? String(input.offset + input.limit) : null,
      total,
    });
  }

  get(exportId: string): ExportRecord {
    const exportRow = this.db.prepare("SELECT * FROM exports WHERE id = ?").get(exportId);
    if (exportRow === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "导出记录不存在" });
    }
    const row = ExportRowSchema.parse(exportRow);
    const jobRow = this.db.prepare("SELECT * FROM export_jobs WHERE export_id = ?").get(exportId);
    if (jobRow === undefined) {
      throw new ApiError({ statusCode: 500, code: "INTERNAL_ERROR", message: "导出任务映射缺失" });
    }
    const job = ExportJobRowSchema.parse(jobRow);
    const rendition = this.requireRendition(row.rendition_id);
    const artifactRows = z.array(ArtifactRowSchema).parse(
      this.db.prepare(
        `SELECT id, kind, file_name, mime, bytes, sha256, storage_relative_path, created_at
         FROM export_artifacts WHERE export_id = ? ORDER BY created_at, id`,
      ).all(exportId),
    );
    const binding = this.db.prepare(
      "SELECT id, rendition_id, exported_revision_id, remote_document_id, remote_url, block_map_json, media_map_json, created_at, updated_at FROM feishu_bindings WHERE rendition_id = ? AND exported_revision_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(row.rendition_id, row.revision_id);
    const bindingRecord = binding === undefined ? null : BindingRowSchema.parse(binding);
    const jobError = this.db.prepare("SELECT error_json FROM jobs WHERE id = ?").get(job.job_id);
    const errorParsed = jobError === undefined ? null : z.strictObject({ error_json: z.string().nullable() }).parse(jobError);
    const status = this.statusFor(row, job.job_id);
    const warningObject = jsonObject(row.warning_json);
    return ExportRecordSchema.parse({
      schemaVersion: 1,
      id: row.id,
      contentId: job.content_id,
      renditionId: row.rendition_id,
      renditionLabel: rendition.label,
      revisionId: row.revision_id,
      format: row.format,
      status,
      jobId: job.job_id,
      speakerNotes: job.speaker_notes === 1,
      rendererVersion: job.renderer_version,
      title: job.title,
      media: JSON.parse(job.media_summary_json) as unknown,
      warnings: [
        ...warningsFrom(warningObject),
        ...(Array.isArray(warningObject.staticized) && warningObject.staticized.length > 0 ? [{
          code: "ANIMATION_STATICIZED",
          message: "动画视频已在静态输出中替换为封面帧。",
        }] : []),
      ],
      artifacts: artifactRows.map((artifact) => this.artifactRecord(exportId, artifact)),
      remoteDocumentId: bindingRecord?.remote_document_id ?? null,
      remoteUrl: bindingRecord?.remote_url ?? null,
      feishuBindingId: bindingRecord?.id ?? null,
      error: errorParsed?.error_json === null || errorParsed?.error_json === undefined
        ? null
        : z.strictObject({
            code: z.string(),
            message: z.string(),
            retryable: z.boolean(),
          }).parse(JSON.parse(errorParsed.error_json) as unknown),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  contentIdForRendition(renditionId: string): string {
    return this.requireRendition(renditionId).content_id;
  }

  preview(renditionId: string, revisionId: string) {
    const revision = loadRevisionOutputSource(this.db, revisionId);
    if (revision.renditionId !== renditionId) {
      throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "修订版本不属于指定稿件分支" });
    }
    const rendition = this.requireRendition(renditionId);
    const content = this.requireContent(rendition.content_id);
    const template = loadOutputTemplate(this.db, revision.templateVersionId, rendition.kind);
    const media = this.planner.plan(revision.ast, { allowMissing: true });
    return OutputPreviewSchema.parse({
      schemaVersion: 1,
      contentId: rendition.content_id,
      renditionId,
      revisionId,
      title: content.title,
      templateName: template.package.manifest.name,
      templateVersionId: template.templateVersionId,
      templateSource: template.source,
      rendererVersion: template.package.rendererVersion,
      media: media.summary,
      warnings: [
        ...media.warnings,
        ...(template.warning === null ? [] : [{ code: "BUILTIN_TEMPLATE_FALLBACK", message: template.warning }]),
      ],
      formats: ["html_zip", "pdf", "project_bundle", "feishu_doc"],
      feishuConfigured: this.hasFeishuCredential(),
    });
  }

  artifactPath(exportId: string, artifactId: string): {
    path: string;
    fileName: string;
    mime: string;
  } {
    const row = this.db.prepare(
      `SELECT id, kind, file_name, mime, bytes, sha256, storage_relative_path, created_at
       FROM export_artifacts WHERE export_id = ? AND id = ?`,
    ).get(exportId, artifactId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "导出文件不存在" });
    }
    const artifact = ArtifactRowSchema.parse(row);
    return {
      path: within(this.dataRoot, join(this.dataRoot, artifact.storage_relative_path)),
      fileName: artifact.file_name,
      mime: artifact.mime,
    };
  }

  createBundleImport(requestValue: unknown, context: WriteContext): { statusCode: number; response: unknown } {
    const request = ProjectBundleImportRequestSchema.parse(requestValue);
    return this.db.transaction(() => {
      const replay = this.replay(context);
      if (replay !== null) return replay;
      const session = this.imports.requireUploadSession(request.fileId);
      if (session.status !== "complete" && session.status !== "scan_ready") {
        throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "项目包上传尚未完成" });
      }
      if (session.sha256 === null || session.mime === null) {
        throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "项目包上传缺少哈希或 MIME" });
      }
      if (!session.fileName.toLowerCase().endsWith(".zip") && session.mime !== "application/zip") {
        throw new ApiError({ statusCode: 415, code: "UNSUPPORTED_FORMAT", message: "项目包必须是 ZIP 文件" });
      }
      const importId = randomUUID();
      const createdAt = now();
      const bundlePath = within(this.dataRoot, join(this.dataRoot, session.stagingRelativePath));
      const jobInput = JobInputSchema.parse({
        schemaVersion: 1,
        jobType: "project_bundle_import",
        importId,
        bundleSha256: session.sha256,
        bundlePath,
      });
      const snapshot = this.jobs.create({
        type: "project_bundle_import",
        input: jobInput,
        inputHash: context.requestHash,
        idempotencyKey: context.key,
      });
      this.db.prepare(
        `INSERT INTO project_bundle_imports
          (id, job_id, bundle_sha256, bundle_relative_path, status, original_title,
           content_id, rendition_id, revision_id, report_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(
        importId,
        snapshot.id,
        session.sha256,
        session.stagingRelativePath,
        request.title ?? null,
        createdAt,
        createdAt,
      );
      const response = {
        data: { schemaVersion: 1, jobId: snapshot.id, status: "queued", importId },
        requestId: context.requestId,
      };
      this.saveIdempotency(context, 202, response, importId);
      return { statusCode: 202, response };
    }).immediate();
  }

  getBundleImport(importId: string) {
    const row = this.db.prepare("SELECT * FROM project_bundle_imports WHERE id = ?").get(importId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "项目包导入记录不存在" });
    }
    const parsed = ImportRowSchema.parse(row);
    return {
      schemaVersion: 1,
      id: parsed.id,
      jobId: parsed.job_id,
      bundleSha256: parsed.bundle_sha256,
      status: parsed.status,
      originalTitle: parsed.original_title,
      contentId: parsed.content_id,
      renditionId: parsed.rendition_id,
      revisionId: parsed.revision_id,
      report: parsed.report_json === null ? null : JSON.parse(parsed.report_json) as unknown,
      error: parsed.error_json === null ? null : JSON.parse(parsed.error_json) as unknown,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    };
  }

  createPull(bindingId: string, requestValue: unknown, context: WriteContext): { statusCode: number; response: unknown } {
    const request = PullRequestSchema.parse(requestValue);
    return this.db.transaction(() => {
      const replay = this.replay(context);
      if (replay !== null) return replay;
      if (!this.hasFeishuCredential()) {
        throw new ApiError({
          statusCode: 409,
          code: "FEISHU_AUTH_MISSING",
          message: "飞书用户凭证未配置，飞书取回已阻断",
          retryable: false,
        });
      }
      const binding = this.requireBinding(bindingId);
      const rendition = this.requireRendition(binding.rendition_id);
      if (rendition.current_revision_id !== request.expectedLocalRevisionId) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "本地稿件已变化，请重新发起飞书取回",
          details: { currentRevisionId: rendition.current_revision_id },
        });
      }
      const pullId = randomUUID();
      const createdAt = now();
      const jobInput = JobInputSchema.parse({
        schemaVersion: 1,
        jobType: "feishu_pull",
        pullId,
        bindingId,
        expectedLocalRevisionId: request.expectedLocalRevisionId,
        remoteDocumentId: binding.remote_document_id,
        remoteUrl: binding.remote_url,
      });
      const snapshot = this.jobs.create({
        type: "feishu_pull",
        input: jobInput,
        inputHash: context.requestHash,
        idempotencyKey: context.key,
      });
      this.db.prepare(
        `INSERT INTO feishu_pull_jobs
          (job_id, pull_id, binding_id, expected_local_revision_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(snapshot.id, pullId, bindingId, request.expectedLocalRevisionId, createdAt, createdAt);
      const response = {
        data: { schemaVersion: 1, jobId: snapshot.id, status: "queued", pullId },
        requestId: context.requestId,
      };
      this.saveIdempotency(context, 202, response, pullId);
      return { statusCode: 202, response };
    }).immediate();
  }

  getPull(pullId: string): PullRecord {
    const row = this.db.prepare("SELECT * FROM pulls WHERE id = ?").get(pullId);
    if (row === undefined) {
      const pending = this.db.prepare(
        `SELECT job_id, binding_id, expected_local_revision_id, status, created_at, updated_at
         FROM feishu_pull_jobs WHERE pull_id = ?`,
      ).get(pullId);
      if (pending === undefined) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "飞书取回记录不存在" });
      }
      const job = z.strictObject({
        job_id: z.uuid(),
        binding_id: z.uuid(),
        expected_local_revision_id: z.uuid(),
        status: z.enum(["queued", "running", "preview", "accepted", "rejected", "failed"]),
        created_at: z.string(),
        updated_at: z.string(),
      }).parse(pending);
      return {
        schemaVersion: 1,
        id: pullId,
        bindingId: job.binding_id,
        jobId: job.job_id,
        sourceVersionId: null,
        baseRevisionId: job.expected_local_revision_id,
        observedCurrentRevisionId: job.expected_local_revision_id,
        status: job.status === "queued" || job.status === "running" ? "queued" : job.status === "failed" ? "failed" : "queued",
        localRevisionId: null,
        ast: null,
        diffCount: 0,
        warnings: [],
        acceptedRenditionId: null,
        acceptedRevisionId: null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      };
    }
    const parsed = PullRowSchema.parse(row);
    const job = this.db.prepare("SELECT job_id FROM feishu_pull_jobs WHERE pull_id = ?").get(pullId);
    const jobId = job === undefined ? randomUUID() : z.strictObject({ job_id: z.uuid() }).parse(job).job_id;
    const diffRow = this.db.prepare("SELECT diff_json FROM feishu_pull_jobs WHERE pull_id = ?").get(pullId);
    const diff = diffRow === undefined
      ? 0
      : z.strictObject({ diff_json: z.string().nullable() }).parse(diffRow).diff_json === null
        ? 0
        : z.strictObject({ count: z.int().nonnegative() }).parse(
            JSON.parse(z.strictObject({ diff_json: z.string() }).parse(diffRow).diff_json) as unknown,
          ).count;
    return {
      schemaVersion: 1,
      id: parsed.id,
      bindingId: parsed.binding_id,
      jobId,
      sourceVersionId: parsed.source_version_id,
      baseRevisionId: parsed.base_revision_id,
      observedCurrentRevisionId: parsed.observed_current_revision_id,
      status: parsed.status,
      localRevisionId: parsed.accepted_revision_id,
      ast: parsed.ast_json === null ? null : AstSchema.parse(JSON.parse(parsed.ast_json) as unknown),
      diffCount: diff,
      warnings: [],
      acceptedRenditionId: parsed.accepted_rendition_id,
      acceptedRevisionId: parsed.accepted_revision_id,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    };
  }

  acceptPull(pullId: string, requestValue: unknown, context: WriteContext): { statusCode: number; response: unknown } {
    const request = AcceptPullRequestSchema.parse(requestValue);
    return this.db.transaction(() => {
      const replay = this.replay(context);
      if (replay !== null) return replay;
      const raw = this.db.prepare("SELECT * FROM pulls WHERE id = ?").get(pullId);
      if (raw === undefined) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "飞书取回记录不存在" });
      }
      const pull = PullRowSchema.parse(raw);
      if (pull.status === "accepted") {
        return {
          statusCode: 200,
          response: { data: this.getPull(pullId), requestId: context.requestId },
        };
      }
      if (pull.status !== "preview") {
        throw new ApiError({ statusCode: 409, code: "JOB_NOT_RESUMABLE", message: "该取回预览不能接受" });
      }
      if (pull.observed_current_revision_id !== request.expectedLocalRevisionId) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "接受取回前本地稿件已变化，请重新取回",
          details: { currentRevisionId: pull.observed_current_revision_id },
        });
      }
      const binding = this.requireBinding(pull.binding_id);
      const rendition = this.requireRendition(binding.rendition_id);
      if (rendition.current_revision_id !== request.expectedLocalRevisionId) {
        throw new ApiError({
          statusCode: 409,
          code: "REVISION_CONFLICT",
          message: "本地稿件当前版本已变化，请刷新后重试",
          details: { currentRevisionId: rendition.current_revision_id },
        });
      }
      const ast = JSON.parse(pull.ast_json ?? "null") as unknown;
      if (ast === null) {
        throw new ApiError({ statusCode: 422, code: "BUNDLE_INVALID", message: "取回预览缺少 AST" });
      }
      const newRenditionId = randomUUID();
      const revisionId = randomUUID();
      const rootNodeId = randomUUID();
      const createdAt = now();
      const label = this.uniqueRenditionLabel(rendition.content_id, rendition.kind, request.label);
      this.db.prepare(
        `INSERT INTO renditions
          (id, content_id, kind, label, root_node_id, current_revision_id,
           derived_from_revision_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
      ).run(newRenditionId, rendition.content_id, rendition.kind, label, rootNodeId, pull.base_revision_id, createdAt, createdAt);
      const parsedAst = AstSchema.parse(ast);
      insertRevisionRecord(this.db, {
        schemaVersion: 1,
        id: revisionId,
        renditionId: newRenditionId,
        parentId: pull.base_revision_id,
        templateVersionId: null,
        ast: parsedAst,
        createdBy: "feishu_pull",
        reason: `飞书取回：${request.label}`,
        createdAt,
      });
      const refs = deriveRevisionRefs({ ast: parsedAst, templateVersionId: null });
      for (const ref of refs) {
        this.db.prepare("INSERT OR IGNORE INTO revision_refs(revision_id, ref_type, ref_id) VALUES (?, ?, ?)")
          .run(revisionId, ref.refType, ref.refId);
      }
      const directRefsJson = JSON.stringify(refs);
      this.db.prepare(
        `INSERT INTO revision_evidence
          (revision_id, schema_version, direct_refs_json, transitive_refs_json, blob_hashes_json,
           bindings_json, binding_hash, created_at)
         VALUES (?, 1, ?, ?, '[]', '[]', ?, ?)`,
      ).run(revisionId, directRefsJson, directRefsJson, sha256Bytes(directRefsJson), createdAt);
      this.db.prepare("UPDATE renditions SET current_revision_id = ?, updated_at = ? WHERE id = ?")
        .run(revisionId, createdAt, newRenditionId);
      this.db.prepare(
        `UPDATE pulls SET status = 'accepted', accepted_rendition_id = ?, accepted_revision_id = ?, updated_at = ?
         WHERE id = ? AND status = 'preview'`,
      ).run(newRenditionId, revisionId, createdAt, pullId);
      this.db.prepare("UPDATE feishu_pull_jobs SET status = 'accepted', updated_at = ? WHERE pull_id = ?")
        .run(createdAt, pullId);
      this.db.prepare("UPDATE contents SET updated_at = ? WHERE id = ?").run(createdAt, rendition.content_id);
      const response = { data: this.getPull(pullId), requestId: context.requestId };
      this.saveIdempotency(context, 200, response, pullId);
      return { statusCode: 200, response };
    }).immediate();
  }

  rejectPull(pullId: string, context: WriteContext): { statusCode: number; response: unknown } {
    return this.db.transaction(() => {
      const replay = this.replay(context);
      if (replay !== null) return replay;
      const updated = this.db.prepare(
        "UPDATE pulls SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'preview'",
      ).run(now(), pullId);
      if (updated.changes === 0) {
        const row = this.db.prepare("SELECT status FROM pulls WHERE id = ?").get(pullId);
        if (row === undefined) {
          throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "飞书取回记录不存在" });
        }
        const status = z.strictObject({ status: z.string() }).parse(row).status;
        if (status !== "rejected") {
          throw new ApiError({ statusCode: 409, code: "JOB_NOT_RESUMABLE", message: "该取回预览不能取消" });
        }
      }
      this.db.prepare("UPDATE feishu_pull_jobs SET status = 'rejected', updated_at = ? WHERE pull_id = ?")
        .run(now(), pullId);
      const response = { data: this.getPull(pullId), requestId: context.requestId };
      this.saveIdempotency(context, 200, response, pullId);
      return { statusCode: 200, response };
    }).immediate();
  }

  attachFeishu(exportId: string, decision: Exclude<OutputDecision, null>, context: WriteContext): {
    statusCode: number;
    response: unknown;
  } {
    return this.db.transaction(() => {
      const job = this.db.prepare("SELECT job_id FROM export_jobs WHERE export_id = ?").get(exportId);
      if (job === undefined) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "导出记录不存在" });
      }
      const jobId = z.strictObject({ job_id: z.uuid() }).parse(job).job_id;
      const snapshot = this.jobs.snapshotById(jobId);
      if (snapshot.state !== "waiting_input") {
        throw new ApiError({ statusCode: 409, code: "JOB_NOT_RESUMABLE", message: "只有等待人工确认的导出可以继续" });
      }
      this.db.prepare(
        `INSERT INTO output_job_decisions(job_id, decision_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET decision_json = excluded.decision_json, updated_at = excluded.updated_at`,
      ).run(jobId, JSON.stringify(decision), now(), now());
      const resumed = this.jobs.resume(jobId);
      const response = { data: resumed.snapshot, requestId: context.requestId };
      this.saveIdempotency(context, 200, response, exportId);
      return { statusCode: 200, response };
    }).immediate();
  }

  private finalizeJob(
    jobId: string,
    state: "queued" | "succeeded" | "partial" | "failed" | "cancelled",
    result: JobResult | null,
  ): { state: "queued" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null } {
    const mapping = this.readJobType(jobId);
    if (mapping === null || state === "queued") return { state, result };
    try {
      if (mapping === "export_output") return this.finalizeExport(jobId, state, result);
      if (mapping === "project_bundle_import") return this.finalizeBundleImport(jobId, state, result);
      if (mapping === "feishu_publish") return this.finalizeFeishuPublish(jobId, state, result);
      if (mapping === "feishu_pull") return this.finalizeFeishuPull(jobId, state, result);
      return { state, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "输出结果提交失败";
      this.db.prepare(
        "UPDATE exports SET status = 'failed', warning_json = ?, updated_at = ? WHERE id IN (SELECT export_id FROM export_jobs WHERE job_id = ?)",
      ).run(JSON.stringify({ warnings: [{ code: "OUTPUT_COMMIT_FAILED", message }] }), now(), jobId);
      this.db.prepare(
        "UPDATE project_bundle_imports SET status = 'failed', error_json = ?, updated_at = ? WHERE job_id = ?",
      ).run(JSON.stringify({ code: "BUNDLE_INVALID", message, retryable: false }), now(), jobId);
      this.db.prepare(
        "UPDATE feishu_pull_jobs SET status = 'failed', updated_at = ? WHERE job_id = ?",
      ).run(now(), jobId);
      return { state: "failed", result };
    }
  }

  private finalizeExport(
    jobId: string,
    state: "succeeded" | "partial" | "failed" | "cancelled",
    result: JobResult | null,
  ): { state: "queued" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null } {
    const mapping = this.db.prepare("SELECT * FROM export_jobs WHERE job_id = ?").get(jobId);
    if (mapping === undefined) return { state, result };
    const exportJob = ExportJobRowSchema.parse(mapping);
    if (state !== "succeeded" && state !== "partial") {
      this.db.prepare("UPDATE exports SET status = ?, updated_at = ? WHERE id = ?")
        .run(state, now(), exportJob.export_id);
      return { state, result };
    }
    if (result === null || result.jobType !== "export_output") {
      this.db.prepare("UPDATE exports SET status = 'failed', updated_at = ? WHERE id = ?")
        .run(now(), exportJob.export_id);
      return { state: "failed", result };
    }
    const workspace = within(join(this.dataRoot, "staging"), join(this.dataRoot, "staging", jobId));
    const exportDir = within(join(this.dataRoot, "exports"), join(this.dataRoot, "exports", exportJob.export_id));
    mkdirSync(exportDir, { recursive: true });
    const verified: Array<z.infer<typeof ArtifactRowSchema>> = [];
    for (const file of result.files) {
      const source = within(workspace, join(workspace, file.relativePath));
      if (!existsSync(source)) throw new Error(`导出文件不存在: ${file.relativePath}`);
      const actualHash = sha256Bytes(readFileSync(source));
      const actualBytes = statSync(source).size;
      if (actualHash !== file.sha256 || actualBytes !== file.bytes) {
        throw new Error(`导出文件校验失败: ${file.relativePath}`);
      }
      const destinationRelative = join("exports", exportJob.export_id, safeFileName(file.fileName));
      const destination = within(join(this.dataRoot, "exports"), join(this.dataRoot, destinationRelative));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      this.ensureBlobFromFile({
        sha256: file.sha256,
        mime: file.mime,
        bytes: file.bytes,
        sourcePath: source,
      });
      const kind = exportJob.format === "html_zip"
        ? "html_zip"
        : exportJob.format === "pdf"
          ? "pdf"
          : "project_bundle";
      const existing = this.db.prepare(
        "SELECT * FROM export_artifacts WHERE export_id = ? AND sha256 = ? AND file_name = ?",
      ).get(exportJob.export_id, file.sha256, safeFileName(file.fileName));
      if (existing !== undefined) {
        verified.push(ArtifactRowSchema.parse(existing));
        continue;
      }
      const artifact = {
        id: randomUUID(),
        kind,
        file_name: safeFileName(file.fileName),
        mime: file.mime,
        bytes: file.bytes,
        sha256: file.sha256,
        storage_relative_path: destinationRelative.split("\\").join("/"),
        created_at: now(),
      } satisfies z.infer<typeof ArtifactRowSchema>;
      this.db.prepare(
        `INSERT INTO export_artifacts
          (id, export_id, kind, file_name, mime, bytes, sha256, storage_relative_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(artifact.id, exportJob.export_id, artifact.kind, artifact.file_name, artifact.mime, artifact.bytes, artifact.sha256, artifact.storage_relative_path, artifact.created_at);
      verified.push(artifact);
    }
    const primary = result.files.find((file) => file.relativePath === result.primaryFile) ?? result.files[0];
    if (primary === undefined) throw new Error("导出结果没有主文件");
    this.db.prepare(
      `UPDATE exports SET status = ?, output_blob_hash = ?, warning_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      state,
      primary.sha256,
      JSON.stringify({
        warnings: result.warnings,
        staticized: result.staticizedMedia,
        manifestHash: result.manifestHash,
      }),
      now(),
      exportJob.export_id,
    );
    return { state, result };
  }

  private finalizeBundleImport(
    jobId: string,
    state: "succeeded" | "partial" | "failed" | "cancelled",
    result: JobResult | null,
  ): { state: "queued" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null } {
    const row = this.db.prepare("SELECT * FROM project_bundle_imports WHERE job_id = ?").get(jobId);
    if (row === undefined) return { state, result };
    const imported = ImportRowSchema.parse(row);
    if (state !== "succeeded" || result === null || result.jobType !== "project_bundle_import") {
      this.db.prepare(
        "UPDATE project_bundle_imports SET status = ?, error_json = ?, updated_at = ? WHERE id = ?",
      ).run(state, result === null ? null : JSON.stringify({ code: "BUNDLE_INVALID", message: "项目包导入未完成" }), now(), imported.id);
      return { state, result };
    }
    try {
      const workspace = within(join(this.dataRoot, "staging"), join(this.dataRoot, "staging", jobId));
      const applied = applyProjectBundleImport({
        db: this.db,
        dataRoot: this.dataRoot,
        workspace,
        payloadPath: result.payloadPath,
        payloadSha256: result.payloadSha256,
        ...(imported.original_title === null ? {} : { titleOverride: imported.original_title }),
      });
      this.db.prepare(
        `UPDATE project_bundle_imports
         SET status = 'succeeded', content_id = ?, rendition_id = ?, revision_id = ?,
             report_json = ?, updated_at = ? WHERE id = ?`,
      ).run(applied.contentId, applied.renditionId, applied.revisionId, JSON.stringify(applied.report), now(), imported.id);
      return { state, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目包导入失败";
      this.db.prepare(
        "UPDATE project_bundle_imports SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?",
      ).run(JSON.stringify({ code: "BUNDLE_INVALID", message, retryable: false }), now(), imported.id);
      return { state: "failed", result };
    }
  }

  private finalizeFeishuPublish(
    jobId: string,
    state: "succeeded" | "partial" | "failed" | "cancelled",
    result: JobResult | null,
  ): { state: "queued" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null } {
    const mapping = this.db.prepare("SELECT * FROM export_jobs WHERE job_id = ?").get(jobId);
    if (mapping === undefined) return { state, result };
    const exportJob = ExportJobRowSchema.parse(mapping);
    if (state === "succeeded" || state === "partial") {
      if (result === null || result.jobType !== "feishu_publish") {
        this.db.prepare("UPDATE exports SET status = 'failed', updated_at = ? WHERE id = ?")
          .run(now(), exportJob.export_id);
        return { state: "failed", result };
      }
      const existing = this.db.prepare(
        "SELECT id FROM feishu_bindings WHERE rendition_id = ? AND exported_revision_id = ? AND remote_document_id = ?",
      ).get(exportJob.rendition_id, exportJob.revision_id, result.documentId);
      if (existing === undefined) {
        this.db.prepare(
          `INSERT INTO feishu_bindings
            (id, rendition_id, exported_revision_id, remote_document_id, remote_url,
             block_map_json, media_map_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), exportJob.rendition_id, exportJob.revision_id, result.documentId,
          result.documentUrl, JSON.stringify(result.blockMap), JSON.stringify(result.mediaMap), now(), now(),
        );
      }
      this.db.prepare(
        "UPDATE exports SET status = ?, warning_json = ?, updated_at = ? WHERE id = ?",
      ).run(state, JSON.stringify({ warnings: result.warnings }), now(), exportJob.export_id);
      return { state, result };
    }
    this.db.prepare("UPDATE exports SET status = ?, updated_at = ? WHERE id = ?")
      .run(state, now(), exportJob.export_id);
    return { state, result };
  }

  private finalizeFeishuPull(
    jobId: string,
    state: "succeeded" | "partial" | "failed" | "cancelled",
    result: JobResult | null,
  ): { state: "queued" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null } {
    const mapping = this.db.prepare("SELECT * FROM feishu_pull_jobs WHERE job_id = ?").get(jobId);
    if (mapping === undefined) return { state, result };
    const pullJob = z.strictObject({
      pull_id: z.uuid(),
      binding_id: z.uuid(),
      expected_local_revision_id: z.uuid(),
    }).parse(mapping);
    if (state !== "succeeded" || result === null || result.jobType !== "feishu_pull") {
      this.db.prepare("UPDATE feishu_pull_jobs SET status = ?, updated_at = ? WHERE job_id = ?")
        .run(state === "cancelled" ? "failed" : state, now(), jobId);
      return { state, result };
    }
    const workspace = within(join(this.dataRoot, "staging"), join(this.dataRoot, "staging", jobId));
    const snapshotPath = within(workspace, join(workspace, result.snapshotPath));
    const snapshotBytes = readFileSync(snapshotPath);
    if (sha256Bytes(snapshotBytes) !== result.snapshotSha256) {
      throw new Error("飞书快照哈希不匹配");
    }
    this.ensureBlobFromBytes({
      sha256: result.snapshotSha256,
      mime: "application/json",
      bytes: snapshotBytes.byteLength,
      bytesValue: snapshotBytes,
    });
    const createdAt = now();
    const canonicalKey = `feishu:${result.documentId}`;
    const existingSource = this.db.prepare(
      "SELECT id FROM sources WHERE canonical_key = ?",
    ).get(canonicalKey);
    const sourceId = existingSource === undefined
      ? randomUUID()
      : z.strictObject({ id: z.uuid() }).parse(existingSource).id;
    if (existingSource === undefined) {
      this.db.prepare(
        `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
         VALUES (?, 'feishu_doc', ?, ?, ?, 'active', ?, ?)`,
      ).run(sourceId, canonicalKey, result.sourceTitle, result.documentUrl, createdAt, createdAt);
    } else {
      this.db.prepare("UPDATE sources SET title = ?, original_uri = ?, updated_at = ? WHERE id = ?")
        .run(result.sourceTitle, result.documentUrl, createdAt, sourceId);
    }
    const existingVersion = this.db.prepare(
      "SELECT id FROM source_versions WHERE source_id = ? AND fingerprint = ?",
    ).get(sourceId, result.snapshotSha256);
    const sourceVersionId = existingVersion === undefined
      ? result.syntheticSourceVersionId
      : z.strictObject({ id: z.uuid() }).parse(existingVersion).id;
    if (existingVersion === undefined) {
      this.db.prepare(
        `INSERT INTO source_versions
          (id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(sourceVersionId, sourceId, result.snapshotSha256, result.snapshotSha256, result.remoteRevision, createdAt, createdAt);
    }

    const idMap = {
      assetVersion: new Map<string, string>(),
      occurrence: new Map<string, string>(),
    };
    for (const media of result.media) {
      const path = within(workspace, join(workspace, media.relativePath));
      const bytes = readFileSync(path);
      if (sha256Bytes(bytes) !== media.sha256) throw new Error("飞书媒体哈希不匹配");
      this.ensureBlobFromBytes({
        sha256: media.sha256,
        mime: media.mime,
        bytes: media.bytes,
        bytesValue: bytes,
      });
      const existingAsset = this.db.prepare("SELECT id FROM assets WHERE blob_hash = ?").get(media.sha256);
      const assetId = existingAsset === undefined
        ? media.assetId
        : z.strictObject({ id: z.uuid() }).parse(existingAsset).id;
      if (existingAsset === undefined) {
        this.db.prepare(
          "INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at) VALUES (?, ?, 'image', ?, ?)",
        ).run(assetId, media.sha256, createdAt, createdAt);
      }
      const existingVersion = this.db.prepare(
        "SELECT id FROM asset_versions WHERE id = ?",
      ).get(media.assetVersionId) ?? this.db.prepare(
        "SELECT id FROM asset_versions WHERE asset_id = ? AND title = ?",
      ).get(assetId, `飞书图片 ${media.blockId}`);
      const assetVersionId = existingVersion === undefined
        ? media.assetVersionId
        : z.strictObject({ id: z.uuid() }).parse(existingVersion).id;
      if (existingVersion === undefined) {
        const version = z.strictObject({ version: z.int().nonnegative() }).parse(
          this.db.prepare("SELECT COALESCE(MAX(version), -1) + 1 AS version FROM asset_versions WHERE asset_id = ?").get(assetId),
        ).version;
        this.db.prepare(
          `INSERT INTO asset_versions
            (id, asset_id, title, metadata_json, human_fields_json, version, created_at)
           VALUES (?, ?, ?, '{}', '{}', ?, ?)`,
        ).run(assetVersionId, assetId, `飞书图片 ${media.blockId}`, version, createdAt);
      }
      const existingOccurrence = this.db.prepare(
        "SELECT id FROM occurrences WHERE source_version_id = ? AND locator_json = ? AND occurrence_index = 0",
      ).get(sourceVersionId, JSON.stringify({ kind: "block", blockId: media.blockId }));
      const occurrenceId = existingOccurrence === undefined
        ? media.occurrenceId
        : z.strictObject({ id: z.uuid() }).parse(existingOccurrence).id;
      if (existingOccurrence === undefined) {
        this.db.prepare(
          `INSERT INTO occurrences
            (id, source_version_id, asset_id, locator_json, occurrence_index, heading_path,
             before_text, after_text, media_status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, '', '', '', 'available', 0, ?, ?)`,
        ).run(occurrenceId, sourceVersionId, assetId, JSON.stringify({ kind: "block", blockId: media.blockId }), createdAt, createdAt);
      }
      idMap.assetVersion.set(media.assetVersionId, assetVersionId);
      idMap.occurrence.set(media.occurrenceId, occurrenceId);
    }
    const ast = rewritePullIds(result.ast, {
      assetVersion: idMap.assetVersion,
      occurrence: idMap.occurrence,
      sourceVersion: new Map([[result.syntheticSourceVersionId, sourceVersionId]]),
    });
    const binding = this.requireBinding(pullJob.binding_id);
    const baseRevision = this.db.prepare("SELECT ast_json FROM revisions WHERE id = ?").get(binding.exported_revision_id);
    const baseAst = baseRevision === undefined
      ? null
      : JSON.parse(z.strictObject({ ast_json: z.string() }).parse(baseRevision).ast_json) as unknown;
    const diffCount = baseAst === null ? 1 : countAstDiff(baseAst, ast);
    this.db.prepare(
      `INSERT INTO pulls
        (id, binding_id, remote_source_version_id, base_revision_id,
         observed_current_revision_id, ast_json, status, accepted_rendition_id,
         accepted_revision_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'preview', NULL, NULL, ?, ?)`,
    ).run(
      pullJob.pull_id,
      pullJob.binding_id,
      sourceVersionId,
      binding.exported_revision_id,
      pullJob.expected_local_revision_id,
      JSON.stringify(ast),
      createdAt,
      createdAt,
    );
    this.db.prepare("UPDATE feishu_pull_jobs SET status = 'preview', diff_json = ?, updated_at = ? WHERE job_id = ?")
      .run(JSON.stringify({ count: diffCount }), createdAt, jobId);
    return { state, result };
  }

  private markWaiting(jobId: string): void {
    this.db.prepare("UPDATE exports SET status = 'waiting_input', updated_at = ? WHERE id IN (SELECT export_id FROM export_jobs WHERE job_id = ?)")
      .run(now(), jobId);
    this.db.prepare("UPDATE project_bundle_imports SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'queued'")
      .run(now(), jobId);
    this.db.prepare("UPDATE feishu_pull_jobs SET status = 'running', updated_at = ? WHERE job_id = ? AND status = 'queued'")
      .run(now(), jobId);
  }

  private statusFor(row: z.infer<typeof ExportRowSchema>, jobId: string): ExportRecord["status"] {
    const job = this.db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId);
    if (job !== undefined) {
      const state = z.strictObject({ state: z.string() }).parse(job).state;
      const parsed = ExportStatusSchema.safeParse(state);
      if (parsed.success && (parsed.data === "waiting_input" || parsed.data === "queued" || parsed.data === "running")) {
        return parsed.data;
      }
    }
    return ExportStatusSchema.parse(row.status);
  }

  private artifactRecord(exportId: string, row: z.infer<typeof ArtifactRowSchema>): ExportArtifact {
    return {
      id: row.id,
      kind: row.kind,
      fileName: row.file_name,
      mime: row.mime,
      bytes: row.bytes,
      sha256: row.sha256,
      downloadUrl: `/api/v1/exports/${exportId}/artifacts/${row.id}/download`,
      createdAt: row.created_at,
    };
  }

  private ensureBlobFromFile(input: {
    sha256: string;
    mime: string;
    bytes: number;
    sourcePath: string;
  }): void {
    const exists = this.db.prepare("SELECT 1 FROM blobs WHERE sha256 = ?").get(input.sha256);
    if (exists !== undefined) return;
    const relative = join("blobs", "sha256", input.sha256.slice(0, 2), input.sha256);
    const destination = join(this.dataRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination)) copyFileSync(input.sourcePath, destination);
    this.db.prepare(
      "INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.sha256, relative.split("\\").join("/"), input.mime, input.bytes, now());
  }

  private ensureBlobFromBytes(input: {
    sha256: string;
    mime: string;
    bytes: number;
    bytesValue: Uint8Array;
  }): void {
    const exists = this.db.prepare("SELECT 1 FROM blobs WHERE sha256 = ?").get(input.sha256);
    if (exists !== undefined) return;
    const relative = join("blobs", "sha256", input.sha256.slice(0, 2), input.sha256);
    const destination = join(this.dataRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination)) writeFileSync(destination, input.bytesValue);
    this.db.prepare(
      "INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.sha256, relative.split("\\").join("/"), input.mime, input.bytes, now());
  }

  private requireRendition(renditionId: string): {
    id: string;
    content_id: string;
    kind: "feishu_doc" | "html_deck";
    label: string;
    current_revision_id: string | null;
  } {
    const row = this.db.prepare(
      "SELECT id, content_id, kind, label, current_revision_id FROM renditions WHERE id = ?",
    ).get(renditionId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "稿件分支不存在" });
    }
    return z.strictObject({
      id: z.uuid(),
      content_id: z.uuid(),
      kind: z.enum(["feishu_doc", "html_deck"]),
      label: z.string(),
      current_revision_id: z.uuid().nullable(),
    }).parse(row);
  }

  private requireContent(contentId: string): { id: string; title: string } {
    const row = this.db.prepare("SELECT id, title FROM contents WHERE id = ?").get(contentId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "内容不存在" });
    }
    return z.strictObject({ id: z.uuid(), title: z.string() }).parse(row);
  }

  private requireBinding(bindingId: string): z.infer<typeof BindingRowSchema> {
    const row = this.db.prepare("SELECT * FROM feishu_bindings WHERE id = ?").get(bindingId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "飞书绑定不存在" });
    }
    return BindingRowSchema.parse(row);
  }

  private revisionContentId(revisionId: string): string {
    const row = this.db.prepare(
      "SELECT r.content_id FROM renditions r JOIN revisions v ON v.rendition_id = r.id WHERE v.id = ?",
    ).get(revisionId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "修订内容不存在" });
    }
    return z.strictObject({ content_id: z.uuid() }).parse(row).content_id;
  }

  private uniqueRenditionLabel(contentId: string, kind: string, base: string): string {
    const existing = new Set(
      z.array(z.strictObject({ label: z.string() })).parse(
        this.db.prepare("SELECT label FROM renditions WHERE content_id = ? AND kind = ?").all(contentId, kind),
      ).map((row) => row.label),
    );
    if (!existing.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base} ${index}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new ApiError({ statusCode: 409, code: "REVISION_CONFLICT", message: "无法分配新的取回分支名称" });
  }

  private readJobType(jobId: string): string | null {
    const row = this.db.prepare("SELECT input_json FROM jobs WHERE id = ?").get(jobId);
    if (row === undefined) return null;
    const input = JSON.parse(z.strictObject({ input_json: z.string() }).parse(row).input_json) as unknown;
    return JobInputSchema.parse(input).jobType;
  }

  private replay(context: WriteContext): { statusCode: number; response: unknown } | null {
    const existing = this.idempotency.find(context.routeScope, context.key);
    if (existing === null) return null;
    if (existing.requestHash !== context.requestHash) {
      throw new ApiError({
        statusCode: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "同一 Idempotency-Key 对应了不同请求",
      });
    }
    return { statusCode: existing.statusCode, response: existing.response };
  }

  private saveIdempotency(context: WriteContext, statusCode: number, response: unknown, resultRef: string): void {
    this.idempotency.save({
      routeScope: context.routeScope,
      key: context.key,
      requestHash: context.requestHash,
      statusCode,
      requestId: context.requestId,
      response,
      resultRef,
    });
  }
}

function rewritePullIds(
  ast: unknown,
  ids: {
    assetVersion: Map<string, string>;
    occurrence: Map<string, string>;
    sourceVersion: Map<string, string>;
  },
): unknown {
  if (Array.isArray(ast)) return ast.map((item) => rewritePullIds(item, ids));
  if (ast === null || typeof ast !== "object") return ast;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ast)) {
    if (typeof value === "string") {
      const mapped =
        key === "assetVersionId" ? ids.assetVersion.get(value) :
        key === "occurrenceId" ? ids.occurrence.get(value) :
        key === "sourceVersionId" ? ids.sourceVersion.get(value) :
        undefined;
      output[key] = mapped ?? value;
    } else {
      output[key] = rewritePullIds(value, ids);
    }
  }
  return output;
}

function countAstDiff(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return 1;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return 1;
    let total = Math.abs(left.length - right.length);
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1) {
      total += countAstDiff(left[index], right[index]);
    }
    return total;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  let total = 0;
  for (const key of keys) total += countAstDiff(leftRecord[key], rightRecord[key]);
  return total;
}

