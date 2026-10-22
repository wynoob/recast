import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ArchiveTemplateRequestSchema,
  CreateTemplateRequestSchema,
  CreateTemplateVersionRequestSchema,
  JobInputSchema,
  ReadyRenderEvidenceSchema,
  TemplateDetailSchema,
  TemplateFromSourceResultSchema,
  TemplatePackageSchema,
  TemplateValidationRecordSchema,
  TemplateValidationResultSchema,
  TemplateVersionRecordSchema,
  ValidateTemplateRequestSchema,
  ValidateTemplateJobSchema,
  type ArchiveTemplateRequest,
  type ContentKind,
  type CreateTemplateRequest,
  type CreateTemplateVersionRequest,
  type JobResult,
  type ReadyRenderEvidence,
  type TemplateDetail,
  type TemplateFromSourceResult,
  type TemplatePackage,
  type TemplateSlot,
  type TemplateStatus,
  type TemplateSummary,
  type TemplateValidationRecord,
  type TemplateVersionRecord,
  type TemplateValidationResult,
  type ValidateTemplateJob,
  type ValidateTemplateRequest,
} from "@dmall/contracts";
import {
  buildBuiltinTemplatePackage,
  canonicalHash,
  renderTemplateSample,
  validateTemplatePackage,
} from "@dmall/templates";
import { markdownHeadings, type MarkdownHeading } from "@dmall/domain";
import type { BlobStore } from "@dmall/storage";
import { ApiError } from "../errors.js";
import type { IdempotencyRepository, IdempotencyRecord } from "../idempotency.js";
import type { JobRepository } from "../job-repository.js";

interface WriteContext {
  routeScope: string;
  key: string;
  requestHash: string;
  requestId: string;
}

const TemplateRowSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["feishu_doc", "html_deck"]),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const VersionRowSchema = z.strictObject({
  id: z.uuid(),
  template_id: z.uuid(),
  version: z.int().positive(),
  kind: z.enum(["feishu_doc", "html_deck"]),
  status: z.enum(["draft", "ready", "archived"]),
  package_json: z.string().nullable(),
  package_hash: z.string().nullable(),
  base_version_id: z.uuid().nullable(),
  change_summary: z.string().nullable(),
  created_at: z.string(),
});

const ValidationRowSchema = z.strictObject({
  id: z.uuid(),
  job_id: z.uuid(),
  status: z.enum(["queued", "running", "passed", "failed", "cancelled"]),
  package_hash: z.string(),
  ast_hash: z.string().nullable(),
  sample_hash: z.string().nullable(),
  pdf_relative_path: z.string().nullable(),
  pdf_sha256: z.string().nullable(),
  report_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const JobTemplateRowSchema = z.strictObject({
  input_json: z.string(),
  attempt: z.int().nonnegative(),
  lease_generation: z.int().nonnegative(),
});

const SourceVersionRowSchema = z.strictObject({
  source_version_id: z.uuid(),
  source_kind: z.string(),
  source_title: z.string(),
  blob_hash: z.string(),
  mime: z.string(),
});

export interface TemplateListFilters {
  q?: string;
  kind?: ContentKind;
  status?: TemplateStatus;
  limit: number;
  offset: number;
}

export class TemplateRepository {
  private readonly db: Database.Database;
  private readonly blobs: BlobStore;
  private readonly idempotency: IdempotencyRepository;
  private readonly jobs: JobRepository;
  private readonly dataRoot: string;

  constructor(input: {
    db: Database.Database;
    blobs: BlobStore;
    idempotency: IdempotencyRepository;
    jobs: JobRepository;
    dataRoot: string;
  }) {
    this.db = input.db;
    this.blobs = input.blobs;
    this.idempotency = input.idempotency;
    this.jobs = input.jobs;
    this.dataRoot = input.dataRoot;
    this.jobs.addLocalFinalizer((jobId, state, result) =>
      this.finalizeValidation(jobId, state, result),
    );
  }

  list(filters: TemplateListFilters): { items: TemplateSummary[]; total: number } {
    const rows = z.array(TemplateRowSchema).parse(
      this.db
        .prepare(
          `SELECT id, kind, name, created_at, updated_at
           FROM templates
           ${filters.kind === undefined ? "" : "WHERE kind = ?"}
           ORDER BY updated_at DESC, id DESC`,
        )
        .all(...(filters.kind === undefined ? [] : [filters.kind])),
    );
    const mapped = rows.flatMap((row) => {
      if (
        filters.q !== undefined &&
        filters.q !== "" &&
        !row.name.toLocaleLowerCase("zh-CN").includes(filters.q.toLocaleLowerCase("zh-CN"))
      ) {
        return [];
      }
      const summary = this.summaryForTemplate(row);
      if (filters.status !== undefined && summary.status !== filters.status) return [];
      return [summary];
    });
    return {
      items: mapped.slice(filters.offset, filters.offset + filters.limit),
      total: mapped.length,
    };
  }

  getDetail(templateId: string, versionId?: string): TemplateDetail {
    const template = this.requireTemplate(templateId);
    const version = versionId === undefined
      ? this.latestVersion(templateId)
      : this.requireVersion(templateId, versionId);
    const versions = z.array(VersionRowSchema).parse(
      this.db
        .prepare(
          `SELECT id, template_id, version, kind, status, package_json, package_hash,
                  base_version_id, change_summary, created_at
           FROM template_versions WHERE template_id = ?
           ORDER BY version DESC`,
        )
        .all(templateId),
    );
    return TemplateDetailSchema.parse({
      summary: this.summaryForTemplate(template),
      version: this.versionRecord(version),
      versions: versions.map((row) => ({
        id: row.id,
        version: row.version,
        status: row.status,
        changeSummary: row.change_summary ?? "历史模板版本",
        packageHash: this.requirePackageHash(row),
        createdAt: row.created_at,
      })),
    });
  }

  create(
    templateId: string,
    body: CreateTemplateRequest,
    context: WriteContext,
  ): TemplateDetail {
    const request = CreateTemplateRequestSchema.parse(body);
    return this.db.transaction(() => {
      const id = templateId;
      const versionId = randomUUID();
      const now = new Date().toISOString();
      const base = buildBuiltinTemplatePackage(request.narrativeId, request.kind);
      const pkg = TemplatePackageSchema.parse({
        ...base,
        manifest: {
          ...base.manifest,
          id,
          templateVersionId: versionId,
          name: request.name,
          version: 1,
          status: "draft",
          previousVersionId: null,
          changeSummary: "本地建立的基础草稿",
          createdAt: now,
          updatedAt: now,
        },
      });
      this.db
        .prepare(
          `INSERT INTO templates(id, kind, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, request.kind, request.name, now, now);
      this.insertVersion({
        id: versionId,
        templateId: id,
        version: 1,
        status: "draft",
        packageValue: pkg,
        baseVersionId: null,
        changeSummary: "本地建立的基础草稿",
        createdAt: now,
      });
      const detail = this.getDetail(id, versionId);
      this.idempotency.save({
        routeScope: context.routeScope,
        key: context.key,
        requestHash: context.requestHash,
        statusCode: 201,
        requestId: context.requestId,
        response: { data: detail, requestId: context.requestId },
        resultRef: id,
      });
      return detail;
    })();
  }

  createVersion(
    templateId: string,
    body: CreateTemplateVersionRequest,
    context: WriteContext,
  ): TemplateDetail {
    const request = CreateTemplateVersionRequestSchema.parse(body);
    return this.db.transaction(() => {
      const template = this.requireTemplate(templateId);
      const latest = this.latestVersion(templateId);
      if (latest.id !== request.baseVersionId) {
        throw new ApiError({
          statusCode: 409,
          code: "TEMPLATE_VERSION_CONFLICT",
          message: "模板已被更新，请基于最新版本重新编辑",
          details: { currentVersionId: latest.id, currentVersion: latest.version },
        });
      }
      if (latest.status === "archived") {
        throw new ApiError({
          statusCode: 409,
          code: "TEMPLATE_VERSION_CONFLICT",
          message: "归档模板不能创建新版本",
        });
      }
      const basePackage = this.packageForRow(latest);
      const id = randomUUID();
      const now = new Date().toISOString();
      const nextVersion = latest.version + 1;
      const pkg = TemplatePackageSchema.parse({
        schemaVersion: 1,
        manifest: {
          ...basePackage.manifest,
          id: templateId,
          templateVersionId: id,
          name: template.name,
          version: nextVersion,
          status: "draft",
          kind: template.kind,
          previousVersionId: latest.id,
          changeSummary: request.changeSummary,
          createdAt: now,
          updatedAt: now,
        },
        narrative: request.narrative,
        layouts: request.layouts,
        theme: request.theme,
        capabilities: request.capabilities,
        slots: request.slots,
        rendererVersion: basePackage.rendererVersion,
      });
      this.insertVersion({
        id,
        templateId,
        version: nextVersion,
        status: "draft",
        packageValue: pkg,
        baseVersionId: latest.id,
        changeSummary: request.changeSummary,
        createdAt: now,
      });
      this.db.prepare("UPDATE templates SET updated_at = ? WHERE id = ?").run(now, templateId);
      const detail = this.getDetail(templateId, id);
      this.idempotency.save({
        routeScope: context.routeScope,
        key: context.key,
        requestHash: context.requestHash,
        statusCode: 201,
        requestId: context.requestId,
        response: { data: detail, requestId: context.requestId },
        resultRef: templateId,
      });
      return detail;
    })();
  }

  validate(
    templateId: string,
    body: ValidateTemplateRequest,
    context: WriteContext,
  ): ValidateTemplateJob {
    const request = ValidateTemplateRequestSchema.parse(body);
    return this.db.transaction(() => {
      const version = this.requireVersion(templateId, request.versionId);
      if (version.status !== "draft") {
        throw new ApiError({
          statusCode: 409,
          code: "TEMPLATE_NOT_READY",
          message: "只有草稿版本需要验证",
        });
      }
      const pkg = this.packageForRow(version);
      const packageHash = canonicalHash(pkg);
      const jobInput = JobInputSchema.parse({
        schemaVersion: 1,
        jobType: "template_validate",
        templateVersionId: version.id,
        templateHash: packageHash,
        templatePackage: pkg,
      });
      const snapshot = this.jobs.create({
        type: "template_validate",
        input: jobInput,
        inputHash: context.requestHash,
        idempotencyKey: context.key,
      });
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO template_validations
            (id, template_version_id, job_id, status, package_hash, ast_hash,
             sample_hash, pdf_relative_path, pdf_sha256, report_json, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(randomUUID(), version.id, snapshot.id, packageHash, now, now);
      const response = ValidateTemplateJobSchema.parse({
        jobId: snapshot.id,
        status: "queued",
        versionId: version.id,
      });
      this.idempotency.save({
        routeScope: context.routeScope,
        key: context.key,
        requestHash: context.requestHash,
        statusCode: 202,
        requestId: context.requestId,
        response: { data: response, requestId: context.requestId },
        resultRef: snapshot.id,
      });
      return response;
    })();
  }

  archive(
    templateId: string,
    body: ArchiveTemplateRequest,
    context: WriteContext,
  ): TemplateDetail {
    const request = ArchiveTemplateRequestSchema.parse(body);
    return this.db.transaction(() => {
      const version = this.requireVersion(templateId, request.versionId);
      if (version.status !== request.expectedStatus) {
        throw new ApiError({
          statusCode: 409,
          code: "TEMPLATE_VERSION_CONFLICT",
          message: "模板版本状态已变化，请刷新后重试",
          details: { currentStatus: version.status },
        });
      }
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE template_versions SET status = 'archived' WHERE id = ?")
        .run(version.id);
      this.db.prepare("UPDATE templates SET updated_at = ? WHERE id = ?").run(now, templateId);
      const detail = this.getDetail(templateId, version.id);
      this.idempotency.save({
        routeScope: context.routeScope,
        key: context.key,
        requestHash: context.requestHash,
        statusCode: 200,
        requestId: context.requestId,
        response: { data: detail, requestId: context.requestId },
        resultRef: templateId,
      });
      return detail;
    })();
  }

  async fromSource(input: {
    sourceVersionId: string;
    headingIds: string[];
    kind: ContentKind;
    templateId: string;
    context: WriteContext;
  }): Promise<IdempotencyRecord> {
    const prepared = await this.prepareFromSource(input.sourceVersionId);
    return this.db.transaction(() => {
      const existing = this.idempotency.find(input.context.routeScope, input.context.key);
      if (existing !== null) {
        if (existing.requestHash !== input.context.requestHash) {
          throw new ApiError({
            statusCode: 409,
            code: "IDEMPOTENCY_CONFLICT",
            message: "同一 Idempotency-Key 对应了不同请求",
          });
        }
        return existing;
      }
      let data: TemplateFromSourceResult;
      if (prepared.status !== "draft_prepared") {
        data = prepared;
      } else {
        const selectedSet = new Set(input.headingIds);
        const selected = prepared.headings.filter((heading) => selectedSet.has(heading.id));
        if (selected.length === 0 || selected.length !== selectedSet.size) {
          throw new ApiError({
            statusCode: 422,
            code: "VALIDATION_ERROR",
            message: "selection.headingIds 必须全部来自该来源的真实标题",
          });
        }
        const id = input.templateId;
        const versionId = randomUUID();
        const now = new Date().toISOString();
        const base = buildBuiltinTemplatePackage("internal-sharing", input.kind);
        const changeSummary = "从 Markdown 标题确定性提取初始结构，需人工检查";
        const narrative = sourceNarrative({
          sourceTitle: prepared.sourceTitle,
          headings: selected,
        });
        const pkg = TemplatePackageSchema.parse({
          ...base,
          manifest: {
            ...base.manifest,
            id,
            templateVersionId: versionId,
            name: `${prepared.sourceTitle}导入草稿`,
            version: 1,
            status: "draft",
            previousVersionId: null,
            changeSummary,
            createdAt: now,
            updatedAt: now,
          },
          narrative,
          slots: sourceSlots(input.kind, narrative),
        });
        this.db
          .prepare(
            `INSERT INTO templates(id, kind, name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, input.kind, pkg.manifest.name, now, now);
        this.insertVersion({
          id: versionId,
          templateId: id,
          version: 1,
          status: "draft",
          packageValue: pkg,
          baseVersionId: null,
          changeSummary,
          createdAt: now,
        });
        const resultDetail = this.getDetail(id, versionId);
        data = { status: "draft_created", detail: resultDetail, reviewRequired: true };
      }
      data = TemplateFromSourceResultSchema.parse(data);
      const record: IdempotencyRecord = {
        requestHash: input.context.requestHash,
        statusCode: data.status === "draft_created" ? 201 : 200,
        requestId: input.context.requestId,
        response: { data, requestId: input.context.requestId },
      };
      this.idempotency.save({
        ...record,
        routeScope: input.context.routeScope,
        key: input.context.key,
        resultRef: data.status === "draft_created" ? data.detail.summary.id : null,
      });
      return record;
    })();
  }

  private async prepareFromSource(sourceVersionId: string): Promise<
    | Exclude<TemplateFromSourceResult, { status: "draft_created" }>
    | { status: "draft_prepared"; sourceTitle: string; headings: MarkdownHeading[] }
  > {
    const source = z.strictObject(SourceVersionRowSchema.shape).parse(
      this.db
        .prepare(
          `SELECT sv.id AS source_version_id, s.kind AS source_kind, s.title AS source_title,
                  sv.snapshot_blob_hash AS blob_hash, b.mime
           FROM source_versions sv
           JOIN sources s ON s.id = sv.source_id
           JOIN blobs b ON b.sha256 = sv.snapshot_blob_hash
           WHERE sv.id = ?`,
        )
        .get(sourceVersionId),
    );
    const descriptor = await this.blobs.describe(source.blob_hash);
    if (descriptor === null || !(await this.blobs.verify(source.blob_hash))) {
      return {
        status: "waiting_input",
        reason: "CONTENT_UNAVAILABLE",
        message: "来源版本存在，但正文文件缺失",
      };
    }
    if (source.source_kind !== "local_markdown" && source.mime !== "text/markdown") {
      return {
        status: "blocked",
        reason: "MODEL_EXTRACTION_REQUIRED",
        message: "当前来源没有可安全确定性解析的 Markdown 正文，需等待模型抽取能力接入",
      };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        readFileSync(this.blobs.pathForHash(source.blob_hash)),
      );
    } catch {
      return {
        status: "waiting_input",
        reason: "CONTENT_UNAVAILABLE",
        message: "来源正文不是有效 UTF-8，无法安全生成结构草稿",
      };
    }
    const headings = markdownHeadings(text);
    if (headings.length === 0) {
      return {
        status: "waiting_input",
        reason: "SOURCE_SECTIONS_UNAVAILABLE",
        message: "Markdown 中没有可用标题，请人工指定结构",
      };
    }
    return { status: "draft_prepared", sourceTitle: source.source_title, headings };
  }

  private finalizeValidation(
    jobId: string,
    state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled",
    result: JobResult | null,
  ): { state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null } {
    if (state === "waiting_input") return { state, result };
    const raw = this.db
      .prepare("SELECT input_json, attempt, lease_generation FROM jobs WHERE id = ?")
      .get(jobId);
    if (raw === undefined) return { state, result };
    const job = JobTemplateRowSchema.parse(raw);
    const jobInput = JobInputSchema.parse(JSON.parse(job.input_json));
    if (jobInput.jobType !== "template_validate") return { state, result };
    if (state === "queued") {
      this.markValidation(jobId, "queued", null);
      return { state, result: null };
    }
    const row = this.db
      .prepare(
        `SELECT id, template_id, version, kind, status, package_json, package_hash,
                base_version_id, change_summary, created_at
         FROM template_versions WHERE id = ?`,
      )
      .get(jobInput.templateVersionId);
    if (row === undefined) {
      this.markValidation(jobId, state === "cancelled" ? "cancelled" : "failed", null);
      return { state: state === "cancelled" ? state : "failed", result };
    }
    const version = VersionRowSchema.parse(row);
    let pkg: TemplatePackage;
    try {
      pkg = this.packageForRow(version);
    } catch {
      this.markValidation(jobId, "failed", null);
      return { state: "failed", result };
    }
    const packageHash = canonicalHash(pkg);
    if (state === "cancelled") {
      this.markValidation(jobId, "cancelled", validateTemplatePackage(pkg));
      return { state, result };
    }
    if (state !== "succeeded" || result?.jobType !== "template_validate") {
      const report = result?.jobType === "template_validate"
        ? result.validation
        : validateTemplatePackage(pkg);
      this.markValidation(jobId, "failed", report);
      return { state: "failed", result };
    }
    const verified = this.verifyValidationResult({
      jobId,
      versionId: version.id,
      job,
      jobInputHash: jobInput.templateHash,
      packageHash,
      result,
      pkg,
    });
    if (verified.kind === "failed") {
      this.markValidation(jobId, "failed", verified.report);
      return { state: "failed", result };
    }
    const updated = version.status === "draft"
      ? this.db
      .prepare("UPDATE template_versions SET status = 'ready' WHERE id = ? AND status = 'draft'")
      .run(version.id)
      : { changes: 0 };
    if (updated.changes !== 1) {
      this.markValidation(jobId, "failed", verified.report);
      return { state: "failed", result };
    }
    this.markValidation(jobId, "passed", verified.report, verified.evidence, verified.pdfRelativePath);
    return { state, result };
  }

  private verifyValidationResult(input: {
    jobId: string;
    versionId: string;
    job: z.infer<typeof JobTemplateRowSchema>;
    jobInputHash: string;
    packageHash: string;
    result: Extract<JobResult, { jobType: "template_validate" }>;
    pkg: TemplatePackage;
  }):
    | { kind: "passed"; report: TemplateValidationResult; evidence: ReadyRenderEvidence; pdfRelativePath: string }
    | { kind: "failed"; report: TemplateValidationResult } {
    if (input.result.templateVersionId !== input.versionId) {
      return { kind: "failed", report: input.result.validation };
    }
    if (
      input.jobInputHash !== input.packageHash ||
      input.result.templateHash !== input.packageHash ||
      input.result.instance === null ||
      input.result.sample === null
    ) {
      return { kind: "failed", report: input.result.validation };
    }
    const evidence = ReadyRenderEvidenceSchema.safeParse(input.result.evidence);
    if (!evidence.success) return { kind: "failed", report: input.result.validation };
    const astHash = canonicalHash(input.result.instance.ast);
    if (
      astHash !== evidence.data.astHash ||
      input.result.astHash !== astHash ||
      input.result.sampleHash !== evidence.data.sampleHash ||
      evidence.data.templateHash !== input.packageHash
    ) {
      return { kind: "failed", report: input.result.validation };
    }
    const render = renderTemplateSample({
      instance: input.result.instance,
      media: input.result.sample.media,
    });
    if (!render.ok || render.artifactHash !== evidence.data.sampleHash) {
      return { kind: "failed", report: input.result.validation };
    }
    if (
      input.result.evidence === null ||
      input.result.artifacts === null ||
      evidence.data.missingResources.length > 0 ||
      evidence.data.externalRequests.length > 0 ||
      evidence.data.overflow.screen ||
      evidence.data.overflow.print
    ) {
      return { kind: "failed", report: input.result.validation };
    }
    const workspace = join(
      this.dataRoot,
      "staging",
      "jobs",
      input.jobId,
      `${input.job.attempt}-${input.job.lease_generation}`,
    );
    const pdfPath = join(workspace, input.result.artifacts.pdfPath);
    if (!existsSync(pdfPath)) return { kind: "failed", report: input.result.validation };
    const pdf = readFileSync(pdfPath);
    if (
      pdf.byteLength !== evidence.data.print.pdfBytes ||
      createHash("sha256").update(pdf).digest("hex") !== evidence.data.print.pdfSha256
    ) {
      return { kind: "failed", report: input.result.validation };
    }
    const report = validateTemplatePackage(input.pkg, {
      mode: "ready",
      instance: input.result.instance,
      sample: input.result.sample,
      evidence: evidence.data,
      now: evidence.data.checkedAt,
    });
    if (!report.ok || !input.result.ok) return { kind: "failed", report };
    return {
      kind: "passed",
      report,
      evidence: evidence.data,
      pdfRelativePath: relative(this.dataRoot, pdfPath).split("\\").join("/"),
    };
  }

  private markValidation(
    jobId: string,
    status: "queued" | "passed" | "failed" | "cancelled",
    report: ReturnType<typeof validateTemplatePackage> | null,
    evidence?: ReadyRenderEvidence,
    pdfRelativePath?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE template_validations
         SET status = ?, ast_hash = ?, sample_hash = ?, pdf_relative_path = ?,
             pdf_sha256 = ?, report_json = ?, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(
        status,
        evidence?.astHash ?? null,
        evidence?.sampleHash ?? null,
        pdfRelativePath ?? null,
        evidence?.print.pdfSha256 ?? null,
        report === null ? null : JSON.stringify(report),
        new Date().toISOString(),
        jobId,
      );
  }

  private insertVersion(input: {
    id: string;
    templateId: string;
    version: number;
    status: TemplateStatus;
    packageValue: TemplatePackage;
    baseVersionId: string | null;
    changeSummary: string;
    createdAt: string;
  }): void {
    const pkg = TemplatePackageSchema.parse(input.packageValue);
    this.db
      .prepare(
        `INSERT INTO template_versions
          (id, template_id, version, kind, narrative_json, layout_json, theme_json,
           capabilities_json, status, created_at, package_json, package_hash,
           base_version_id, change_summary, slots_json, renderer_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.templateId,
        input.version,
        pkg.manifest.kind,
        JSON.stringify(pkg.narrative),
        JSON.stringify(pkg.layouts),
        JSON.stringify(pkg.theme),
        JSON.stringify(pkg.capabilities),
        input.status,
        input.createdAt,
        JSON.stringify(pkg),
        canonicalHash(pkg),
        input.baseVersionId,
        input.changeSummary,
        JSON.stringify(pkg.slots),
        pkg.rendererVersion,
      );
  }

  private summaryForTemplate(template: z.infer<typeof TemplateRowSchema>): TemplateSummary {
    const latest = this.latestVersion(template.id);
    const pkg = this.packageForRow(latest);
    const validation = this.validationForJobOrVersion(latest.id);
    return {
      id: template.id,
      kind: template.kind,
      name: template.name,
      narrativeId: pkg.narrative.id,
      narrativeName: pkg.narrative.name,
      narrativeSummary: pkg.narrative.summary,
      status: latest.status,
      currentVersionId: latest.id,
      currentVersion: latest.version,
      validationStatus: validation?.status ?? "not_validated",
      createdAt: template.created_at,
      updatedAt: template.updated_at,
    };
  }

  private versionRecord(row: z.infer<typeof VersionRowSchema>): TemplateVersionRecord {
    const pkg = this.packageForRow(row);
    return TemplateVersionRecordSchema.parse({
      id: row.id,
      templateId: row.template_id,
      version: row.version,
      kind: row.kind,
      status: row.status,
      baseVersionId: row.base_version_id,
      changeSummary: row.change_summary ?? "历史模板版本",
      package: pkg,
      packageHash: this.requirePackageHash(row),
      validation: this.validationForJobOrVersion(row.id),
      createdAt: row.created_at,
    });
  }

  private validationForJobOrVersion(versionId: string): TemplateValidationRecord | null {
    const raw = this.db
      .prepare(
        `SELECT id, job_id, status, package_hash, ast_hash, sample_hash,
                pdf_relative_path, pdf_sha256, report_json, created_at, updated_at
         FROM template_validations WHERE template_version_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(versionId);
    if (raw === undefined) return null;
    const row = ValidationRowSchema.parse(raw);
    return TemplateValidationRecordSchema.parse({
      id: row.id,
      jobId: row.job_id,
      status: row.status,
      packageHash: row.package_hash,
      astHash: row.ast_hash,
      sampleHash: row.sample_hash,
      pdfPath: row.pdf_relative_path,
      pdfSha256: row.pdf_sha256,
      report: row.report_json === null
        ? null
        : TemplateValidationResultSchema.parse(JSON.parse(row.report_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private requireTemplate(templateId: string): z.infer<typeof TemplateRowSchema> {
    const row = this.db
      .prepare("SELECT id, kind, name, created_at, updated_at FROM templates WHERE id = ?")
      .get(templateId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "模板不存在" });
    }
    return TemplateRowSchema.parse(row);
  }

  private requireVersion(templateId: string, versionId: string): z.infer<typeof VersionRowSchema> {
    const row = this.db
      .prepare(
        `SELECT id, template_id, version, kind, status, package_json, package_hash,
                base_version_id, change_summary, created_at
         FROM template_versions WHERE template_id = ? AND id = ?`,
      )
      .get(templateId, versionId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "模板版本不存在" });
    }
    return VersionRowSchema.parse(row);
  }

  private latestVersion(templateId: string): z.infer<typeof VersionRowSchema> {
    const row = this.db
      .prepare(
        `SELECT id, template_id, version, kind, status, package_json, package_hash,
                base_version_id, change_summary, created_at
         FROM template_versions WHERE template_id = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(templateId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "模板没有版本" });
    }
    return VersionRowSchema.parse(row);
  }

  private packageForRow(row: z.infer<typeof VersionRowSchema>): TemplatePackage {
    if (row.package_json === null) {
      throw new ApiError({
        statusCode: 422,
        code: "TEMPLATE_INVALID",
        message: "旧模板版本缺少单源模板包，请创建新版本",
      });
    }
    return TemplatePackageSchema.parse(JSON.parse(row.package_json));
  }

  private requirePackageHash(row: z.infer<typeof VersionRowSchema>): string {
    if (row.package_hash === null) {
      throw new ApiError({
        statusCode: 422,
        code: "TEMPLATE_INVALID",
        message: "旧模板版本缺少 package hash",
      });
    }
    return row.package_hash;
  }
}

function sourceNarrative(input: {
  sourceTitle: string;
  headings: MarkdownHeading[];
}) {
  const sections = input.headings.map((heading) => ({
    id: heading.id,
    title: heading.title,
    purpose: "从 Markdown 标题提取，正文和证据需人工检查。",
    requiredEvidence: [],
  }));
  const slides = [
    {
      id: "cover",
      layout: "cover" as const,
      title: input.sourceTitle,
      purpose: "来源结构草稿封面，需人工检查。",
    },
    ...input.headings.map((heading) => ({
      id: heading.id,
      layout: "section" as const,
      title: heading.title,
      purpose: "从来源标题确定性提取，需人工检查。",
    })),
    {
      id: "closing",
      layout: "closing" as const,
      title: "下一步",
      purpose: "确认结构和正文后再验证模板。",
    },
  ];
  return {
    id: "internal-sharing" as const,
    name: "来源结构草稿",
    summary: `${input.sourceTitle}的确定性结构初稿，待人工检查。`,
    doc: { sections },
    deck: { slides },
  };
}

function sourceSlots(
  kind: ContentKind,
  narrative: ReturnType<typeof sourceNarrative>,
): TemplateSlot[] {
  if (kind === "feishu_doc") {
    return narrative.doc.sections.map((section) => ({
      id: `${section.id}-body`,
      containerId: section.id,
      order: 0,
      label: `${section.title}正文`,
      blockType: "paragraph" as const,
      required: false,
      capacity: { maxCharacters: 500 },
      source: {
        kind: "default" as const,
        value: {
          kind: "text" as const,
          text: `待检查：${section.title}正文需人工补全。`,
        },
      },
    }));
  }
  return narrative.deck.slides.flatMap((slide): TemplateSlot[] => {
    if (slide.layout === "cover") {
      return [{
        id: `${slide.id}-subtitle`,
        containerId: slide.id,
        layoutSlotId: "subtitle",
        order: 0,
        label: "副标题",
        blockType: "paragraph" as const,
        required: true,
        capacity: { maxCharacters: 80 },
        source: {
          kind: "default" as const,
          value: { kind: "text" as const, text: "来源结构草稿，需人工检查。" },
        },
      }];
    }
    if (slide.layout === "section") {
      return [{
        id: `${slide.id}-intro`,
        containerId: slide.id,
        layoutSlotId: "intro",
        order: 0,
        label: "章节导语",
        blockType: "paragraph" as const,
        required: true,
        capacity: { maxCharacters: 120 },
        source: {
          kind: "default" as const,
          value: { kind: "text" as const, text: "待检查：章节内容来自来源标题，需人工补全。" },
        },
      }];
    }
    return [{
      id: `${slide.id}-next`,
      containerId: slide.id,
      layoutSlotId: "next",
      order: 0,
      label: "下一步",
      blockType: "list" as const,
      required: true,
      capacity: { maxItems: 4, maxCharacters: 36 },
      source: {
        kind: "default" as const,
        value: { kind: "list" as const, items: ["检查结构", "补全正文", "启动验证"] },
      },
    }];
  });
}
