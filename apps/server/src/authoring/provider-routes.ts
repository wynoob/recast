import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  JobInputSchema,
  JobSnapshotSchema,
} from "@dmall/contracts";
import { ApiError, requestIdFor } from "../errors.js";
import type { IdempotencyRepository } from "../idempotency.js";
import type { JobRepository } from "../job-repository.js";
import { GenerationInputService } from "./generation-inputs.js";
import { PlanService } from "./plans.js";

export function registerProviderRoutes(input: {
  app: FastifyInstance;
  db: Database.Database;
  jobs: JobRepository;
  idempotency: IdempotencyRepository;
  generationInputs: GenerationInputService;
  plans: PlanService;
}): void {
  const { app, db, jobs, idempotency, generationInputs, plans } = input;

  jobs.addLocalFinalizer((jobId, state, result) => {
    if (state !== "succeeded" || result?.jobType !== "authoring_probe") return { state, result };
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE provider_configs SET capabilities_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify({
      verified: true,
      verifiedAt: now,
      probeJobId: jobId,
      lastCost: result.cost,
    }), now, result.providerId);
    return { state, result };
  });

  app.post("/api/v1/generation-inputs/:id/generate", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = z.strictObject({
      schemaVersion: z.literal(1),
      task: z.enum(["plan", "generate", "revise"]).default("generate"),
    }).parse(request.body);
    const scope = `POST /api/v1/generation-inputs/${id}/generate`;
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const requestHash = idempotency.requestHash({ id, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT", message: "同一 Idempotency-Key 对应了不同请求" });
      }
      return reply.code(existing.statusCode).send(existing.response);
    }
    const fixed = generationInputs.require(id);
    const provider = requireProvider(db, "text");
    const readiness = generationInputs.readiness(fixed, true);
    if (readiness.kind !== "ready") {
      throw new ApiError({
        statusCode: 409,
        code: readiness.reasons.some((reason) => reason.kind === "capability")
          ? "MODEL_CAPABILITY_MISSING"
          : "VALIDATION_ERROR",
        message: readiness.reasons.some((reason) => reason.kind === "capability")
          ? "文本模型尚未配置，生成任务未创建"
          : "生成输入仍有需要确认的问题",
        details: { reasons: readiness.reasons },
      });
    }
    const confirmation = plans.getConfirmation(fixed.confirmationId);
    const envelope = {
      role: "text" as const,
      providerId: provider.id,
      modelId: provider.modelId,
      providerConfigVersion: `${provider.id}:${provider.updatedAt}`,
      promptVersion: fixed.promptVersion,
      responseSchemaId: "authoring_operations/1" as const,
      messages: [
        {
          role: "system" as const,
          content: "你是内容工作台的结构编辑。只输出 JSON：{\"operations\": AuthoringOperation[], \"claims\": Claim[]}。不得改写选定证据之外的事实，不得修改 locks，不得使用整份 AST 替换。",
        },
        {
          role: "user" as const,
          content: JSON.stringify({
            task: body.task,
            targetKind: fixed.targetKind,
            targetNodeIds: fixed.targetNodeIds,
            templateVersionId: fixed.templateVersionId,
            brief: confirmation.brief,
            outline: confirmation.outline,
            questionDecisions: confirmation.questionDecisions,
            evidence: fixed.evidence,
            baseRevisionId: fixed.baseRevisionId,
          }),
        },
      ],
      toolsDisabled: true as const,
      timeoutMs: provider.timeoutMs,
    };
    const jobInput = JobInputSchema.parse({
      schemaVersion: 1,
      jobType: "authoring_provider",
      contentId: fixed.contentId,
      renditionId: fixed.renditionId,
      inputId: fixed.id,
      task: body.task,
      provider: {
        role: "text",
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        modelId: provider.modelId,
        credentialEnv: provider.credentialEnv,
        timeoutMs: provider.timeoutMs,
      },
      requestEnvelope: envelope,
    });
    const requestId = requestIdFor(request);
    const response = db.transaction(() => {
      const job = jobs.create({
        type: "authoring_provider",
        input: jobInput,
        inputHash: fixed.inputHash,
        idempotencyKey: key,
      });
      const payload = { data: JobSnapshotSchema.parse(job), requestId };
      idempotency.save({
        routeScope: scope,
        key,
        requestHash,
        statusCode: 202,
        requestId,
        response: payload,
        resultRef: job.id,
      });
      return payload;
    })();
    return reply.code(202).send(response);
  });

  app.post("/api/v1/contents/:id/transcribe", async (request, reply) => {
    const { id: contentId } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = z.strictObject({
      schemaVersion: z.literal(1),
      renditionId: z.uuid().nullable(),
      audioBase64: z.string().min(1).max(20_000_000),
      mimeType: z.string().min(1).max(100),
      language: z.string().min(2).max(20).default("zh"),
    }).parse(request.body);
    const scope = `POST /api/v1/contents/${contentId}/transcribe`;
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const requestHash = idempotency.requestHash({ contentId, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT", message: "同一 Idempotency-Key 对应了不同请求" });
      }
      return reply.code(existing.statusCode).send(existing.response);
    }
    const provider = readProviderConfig(db, "asr", false);
    const audio = Buffer.from(body.audioBase64, "base64");
    if (audio.byteLength === 0) {
      throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "录音内容为空" });
    }
    const audioSha256 = createHash("sha256").update(audio).digest("hex");
    const envelope = {
      role: "asr" as const,
      providerId: provider.id,
      modelId: provider.modelId,
      providerConfigVersion: `${provider.id}:${provider.updatedAt}`,
      promptVersion: "t06-asr/1",
      responseSchemaId: "transcript_text/1" as const,
      language: body.language,
      audioBytes: audio.byteLength,
      audioSha256,
      mimeType: body.mimeType,
      toolsDisabled: true as const,
      timeoutMs: provider.timeoutMs,
    };
    const jobInput = JobInputSchema.parse({
      schemaVersion: 1,
      jobType: "authoring_transcription",
      contentId,
      renditionId: body.renditionId,
      provider: {
        role: "asr",
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        modelId: provider.modelId,
        credentialEnv: provider.credentialEnv,
        timeoutMs: provider.timeoutMs,
      },
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
      language: body.language,
      requestEnvelope: envelope,
    });
    const requestId = requestIdFor(request);
    const response = db.transaction(() => {
      const job = jobs.create({
        type: "authoring_transcription",
        input: jobInput,
        inputHash: requestHash,
        idempotencyKey: key,
      });
      const payload = { data: JobSnapshotSchema.parse(job), requestId };
      idempotency.save({
        routeScope: scope,
        key,
        requestHash,
        statusCode: 202,
        requestId,
        response: payload,
        resultRef: job.id,
      });
      return payload;
    })();
    return reply.code(202).send(response);
  });

  app.post("/api/v1/settings/providers/:role/probe", async (request, reply) => {
    const { role } = z.strictObject({ role: z.literal("text") }).parse(request.params);
    const scope = `POST /api/v1/settings/providers/${role}/probe`;
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const body = { schemaVersion: 1, role };
    const requestHash = idempotency.requestHash(body);
    const existing = idempotency.find(scope, key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT", message: "同一 Idempotency-Key 对应了不同请求" });
      }
      return reply.code(existing.statusCode).send(existing.response);
    }
    const provider = readProviderConfig(db, role, false);
    const envelope = {
      role: "text" as const,
      providerId: provider.id,
      modelId: provider.modelId,
      providerConfigVersion: `${provider.id}:${provider.updatedAt}`,
      promptVersion: "t06-provider-probe/1" as const,
      responseSchemaId: "provider_probe/1" as const,
      messages: [
        { role: "system" as const, content: "这是连接探针。只回复 OK。" },
        { role: "user" as const, content: "OK" },
      ],
      toolsDisabled: true as const,
      timeoutMs: provider.timeoutMs,
    };
    const jobInput = JobInputSchema.parse({
      schemaVersion: 1,
      jobType: "authoring_probe",
      provider: {
        role: "text",
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        modelId: provider.modelId,
        credentialEnv: provider.credentialEnv,
        timeoutMs: provider.timeoutMs,
      },
      requestEnvelope: envelope,
    });
    const requestId = requestIdFor(request);
    const response = db.transaction(() => {
      const job = jobs.create({
        type: "authoring_probe",
        input: jobInput,
        inputHash: requestHash,
        idempotencyKey: key,
      });
      const payload = { data: JobSnapshotSchema.parse(job), requestId };
      idempotency.save({
        routeScope: scope,
        key,
        requestHash,
        statusCode: 202,
        requestId,
        response: payload,
        resultRef: job.id,
      });
      return payload;
    })();
    return reply.code(202).send(response);
  });
}

function requireProvider(db: Database.Database, role: "text" | "asr"): {
  id: string;
  baseUrl: string;
  modelId: string;
  credentialEnv: string;
  updatedAt: string;
  timeoutMs: number;
} {
  return readProviderConfig(db, role, true);
}

function readProviderConfig(db: Database.Database, role: "text" | "asr", requireVerified = true): {
  id: string;
  baseUrl: string;
  modelId: string;
  credentialEnv: string;
  updatedAt: string;
  timeoutMs: number;
} {
  const row = db.prepare(
    "SELECT id, base_url, model_id, keychain_ref, updated_at, capabilities_json FROM provider_configs WHERE role = ? ORDER BY updated_at DESC LIMIT 1",
  ).get(role);
  if (row === undefined) {
    throw new ApiError({
      statusCode: 409,
      code: "MODEL_CAPABILITY_MISSING",
      message: `${role === "text" ? "文本模型" : "语音转写"}尚未配置`,
    });
  }
  const parsed = z.strictObject({
    id: z.uuid(),
    base_url: z.string().url(),
    model_id: z.string(),
    keychain_ref: z.string().nullable(),
    updated_at: z.string(),
    capabilities_json: z.string(),
  }).parse(row);
  if (parsed.keychain_ref === null) {
    throw new ApiError({
      statusCode: 409,
      code: "MODEL_CAPABILITY_MISSING",
      message: "缺少本机凭证环境变量名",
    });
  }
  const capabilities = z.object({ verified: z.boolean().optional(), timeoutMs: z.number().int().positive().optional() }).parse(
    JSON.parse(parsed.capabilities_json),
  );
  if (requireVerified && capabilities.verified !== true) {
    throw new ApiError({
      statusCode: 409,
      code: "MODEL_CAPABILITY_MISSING",
      message: "模型配置尚未完成验证，未创建外部调用",
    });
  }
  return {
    id: parsed.id,
    baseUrl: parsed.base_url,
    modelId: parsed.model_id,
    credentialEnv: parsed.keychain_ref,
    updatedAt: parsed.updated_at,
    timeoutMs: capabilities.timeoutMs ?? 120_000,
  };
}
