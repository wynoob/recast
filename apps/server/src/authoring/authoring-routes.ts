import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AcceptCandidateRequestSchema,
  CandidateViewSchema,
  CreateCandidateRequestSchema,
  ConfirmPlanRequestSchema,
  CreateGenerationInputRequestSchema,
  CreateMessageRequestSchema,
  DeriveRenditionRequestSchema,
  EvidenceSelectRequestSchema,
  GenerationReadinessSchema,
  MergePreviewSchema,
  ProviderConfigInputSchema,
  ProviderConfigViewSchema,
  RejectCandidateRequestSchema,
} from "@dmall/contracts";
import { MergeResolutionError } from "@dmall/domain";
import { ApiError, requestIdFor } from "../errors.js";
import type { IdempotencyRepository, IdempotencyRecord } from "../idempotency.js";
import type { AuthoringEvidenceService } from "../authoring-evidence.js";
import { CandidateAcceptService } from "./accept.js";
import { CandidateService } from "./candidates.js";
import { DeriveService } from "./derive.js";
import { GenerationInputService } from "./generation-inputs.js";
import { LocalGenerationService } from "./local-generation.js";
import { MessageService } from "./messages.js";
import { PlanService } from "./plans.js";
import { RevisionCommitError } from "./revision-commit.js";
import type { RevisionRepository } from "./revisions.js";

export function registerFullAuthoringRoutes(input: {
  app: FastifyInstance;
  idempotency: IdempotencyRepository;
  revisions: RevisionRepository;
  messages: MessageService;
  plans: PlanService;
  evidence: AuthoringEvidenceService;
  generationInputs: GenerationInputService;
  candidates: CandidateService;
  accept: CandidateAcceptService;
  localGeneration: LocalGenerationService;
  derive: DeriveService;
  db: import("better-sqlite3").Database;
}): void {
  const { app, idempotency } = input;

  app.get("/api/v1/contents/:id/messages", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return {
      data: { items: input.messages.list(id) },
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/contents/:id/messages", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = CreateMessageRequestSchema.parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/contents/${id}/messages`,
      body,
      statusCode: 201,
      execute: () => {
        const message = input.messages.create(id, body);
        return {
          data: {
            message,
            providerRun: body.mode === "note" ? "not_requested" : "unconfigured",
          },
        };
      },
    });
  });

  app.get("/api/v1/contents/:id/plan", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const confirmation = input.plans.latest(id);
    return {
      data: confirmation === null
        ? { confirmation: null, current: false, messages: input.messages.list(id) }
        : {
            confirmation,
            current: input.plans.isCurrent(id, confirmation),
            messages: input.messages.list(id),
          },
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/contents/:id/plan/confirm", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = ConfirmPlanRequestSchema.parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/contents/${id}/plan/confirm`,
      body,
      statusCode: 201,
      execute: () => ({ data: input.plans.confirm(id, body) }),
    });
  });

  app.get("/api/v1/contents/:id/evidence", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return {
      data: { items: input.evidence.list(id) },
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/contents/:id/evidence/select", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = EvidenceSelectRequestSchema.parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/contents/${id}/evidence/select`,
      body,
      statusCode: 201,
      execute: () => ({ data: { items: input.evidence.select(id, body.selectionHandles) } }),
    });
  });

  app.post("/api/v1/renditions/:id/generation-inputs", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = CreateGenerationInputRequestSchema.extend({
      contentId: z.uuid(),
    }).parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/renditions/${id}/generation-inputs`,
      body,
      statusCode: 201,
      execute: () => {
        const { contentId, ...generationRequest } = body;
        return {
          data: input.generationInputs.create(contentId, id, generationRequest),
        };
      },
    });
  });

  app.get("/api/v1/generation-inputs/:id", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return { data: input.generationInputs.require(id), requestId: requestIdFor(request) };
  });

  app.get("/api/v1/generation-inputs/:id/readiness", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const query = z.strictObject({ forProvider: z.enum(["true", "false"]).default("false") }).parse(request.query);
    const value = input.generationInputs.require(id);
    return {
      data: GenerationReadinessSchema.parse(
        input.generationInputs.readiness(value, query.forProvider === "true"),
      ),
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/renditions/:id/local-generation", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = z.strictObject({
      schemaVersion: z.literal(1),
      contentId: z.uuid(),
      inputId: z.uuid(),
    }).parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/renditions/${id}/local-generation`,
      body,
      statusCode: 201,
      execute: () => ({
        data: input.localGeneration.generate(body.contentId, id, body.inputId),
      }),
    });
  });

  app.post("/api/v1/renditions/:id/candidates", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = CreateCandidateRequestSchema.parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/renditions/${id}/candidates`,
      body,
      statusCode: 201,
      execute: () => ({
        data: CandidateViewSchema.parse(input.candidates.create(id, body)),
      }),
    });
  });

  app.get("/api/v1/candidates/:id", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return { data: input.candidates.require(id), requestId: requestIdFor(request) };
  });

  app.get("/api/v1/candidates/:id/preview", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return {
      data: MergePreviewSchema.parse(input.candidates.preview(id)),
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/candidates/:id/accept", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = AcceptCandidateRequestSchema.parse(request.body);
    const scope = `POST /api/v1/candidates/${id}/accept`;
    const requestHash = idempotency.requestHash({ id, body });
    try {
      const result = input.accept.accept(id, body, {
        routeScope: scope,
        key: idempotency.requireKey(request.headers["idempotency-key"]),
        requestHash,
        requestId: requestIdFor(request),
      });
      return reply.code(result.statusCode).send(result.response);
    } catch (error) {
      throw serviceError(error);
    }
  });

  app.post("/api/v1/candidates/:id/reject", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = RejectCandidateRequestSchema.parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/candidates/${id}/reject`,
      body,
      statusCode: 200,
      execute: () => ({
        data: input.candidates.reject(id, {
          expectedRevisionId: body.expectedRevisionId,
          reason: body.reason,
        }),
      }),
    });
  });

  app.post("/api/v1/contents/:id/derive", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = DeriveRenditionRequestSchema.parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: `POST /api/v1/contents/${id}/derive`,
      body,
      statusCode: 201,
      execute: () => ({ data: input.derive.derive(id, body) }),
    });
  });

  app.get("/api/v1/settings/providers", async (request) => ({
    data: { items: readProviderViews(input.db) },
    requestId: requestIdFor(request),
  }));

  app.put("/api/v1/settings/providers", async (request, reply) => {
    const body = ProviderConfigInputSchema.parse(request.body);
    return writeOnce({
      request,
      reply,
      idempotency,
      scope: "PUT /api/v1/settings/providers",
      body,
      statusCode: 200,
      execute: () => {
        const now = new Date().toISOString();
        const existing = input.db.prepare(
          "SELECT id FROM provider_configs WHERE role = ?",
        ).get(body.role);
        if (existing === undefined) {
          input.db.prepare(
            `INSERT INTO provider_configs(
              id, role, base_url, model_id, capabilities_json, keychain_ref, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            body.role,
            body.baseUrl,
            body.modelId,
            JSON.stringify({ verified: false, secretSource: "environment" }),
            body.keychainRef,
            now,
            now,
          );
        } else {
          const id = z.strictObject({ id: z.uuid() }).parse(existing).id;
          input.db.prepare(
            `UPDATE provider_configs
             SET base_url = ?, model_id = ?, capabilities_json = ?, keychain_ref = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            body.baseUrl,
            body.modelId,
            JSON.stringify({ verified: false, secretSource: "environment" }),
            body.keychainRef,
            now,
            id,
          );
        }
        const item = readProviderViews(input.db).find((candidate) => candidate.role === body.role);
        if (item === undefined) throw new Error("provider config missing after write");
        return { data: { item: ProviderConfigViewSchema.parse(item) } };
      },
    });
  });
}

function writeOnce(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  idempotency: IdempotencyRepository;
  scope: string;
  body: unknown;
  statusCode: number;
  execute: () => { data: unknown };
}): FastifyReply {
  const hash = input.idempotency.requestHash(input.body);
  const key = input.idempotency.requireKey(input.request.headers["idempotency-key"]);
  const existing = input.idempotency.find(input.scope, key);
  if (existing !== null) return replay(input.reply, existing, hash);
  try {
    const requestId = requestIdFor(input.request);
    const payload = { ...input.execute(), requestId };
    input.idempotency.save({
      routeScope: input.scope,
      key,
      requestHash: hash,
      statusCode: input.statusCode,
      requestId,
      response: payload,
      resultRef: null,
    });
    return input.reply.code(input.statusCode).send(payload);
  } catch (error) {
    throw serviceError(error);
  }
}

function replay(reply: FastifyReply, existing: IdempotencyRecord, hash: string): FastifyReply {
  if (existing.requestHash !== hash) {
    throw new ApiError({
      statusCode: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message: "同一 Idempotency-Key 对应了不同请求",
    });
  }
  return reply.code(existing.statusCode).send(existing.response);
}

function serviceError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof RevisionCommitError) {
    return new ApiError({
      statusCode: error.code === "REVISION_CONFLICT" || error.code === "LOCKED_FIELD" ? 409 : 422,
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  if (error instanceof MergeResolutionError) {
    return new ApiError({
      statusCode: error.code === "LOCKED_FIELD" ? 409 : 422,
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  return error;
}

function readProviderViews(db: import("better-sqlite3").Database): import("@dmall/contracts").ProviderConfigView[] {
  const rows = z.array(z.strictObject({
    id: z.uuid(),
    role: z.enum(["text", "embedding", "vision", "asr"]),
    base_url: z.string(),
    model_id: z.string(),
    keychain_ref: z.string().nullable(),
    capabilities_json: z.string(),
    updated_at: z.string(),
  })).parse(db.prepare(
    "SELECT id, role, base_url, model_id, keychain_ref, capabilities_json, updated_at FROM provider_configs ORDER BY role",
  ).all());
  const roles = ["text", "embedding", "vision", "asr"] as const;
  return roles.map((role) => {
    const row = rows.find((item) => item.role === role);
    if (row === undefined) {
      return ProviderConfigViewSchema.parse({
        id: null,
        role,
        baseUrl: null,
        modelId: null,
        keychainRef: null,
        configured: false,
        verified: false,
        updatedAt: null,
      });
    }
    const capabilities = z.object({ verified: z.boolean().optional() }).parse(JSON.parse(row.capabilities_json));
    return ProviderConfigViewSchema.parse({
      id: row.id,
      role: row.role,
      baseUrl: row.base_url,
      modelId: row.model_id,
      keychainRef: row.keychain_ref,
      configured: true,
      verified: capabilities.verified === true,
      updatedAt: row.updated_at,
    });
  });
}
