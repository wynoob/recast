import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ArchiveTemplateRequestSchema,
  CreateTemplateRequestSchema,
  CreateTemplateVersionRequestSchema,
  TemplateDetailSchema,
  TemplateFromSourceRequestSchema,
  TemplateListSchema,
  ValidateTemplateJobSchema,
  ValidateTemplateRequestSchema,
  type TemplateStatus,
} from "@dmall/contracts";
import { ApiError, requestIdFor } from "../errors.js";
import type { IdempotencyRepository, IdempotencyRecord } from "../idempotency.js";
import type { TemplateRepository } from "./template-repository.js";

export function registerTemplateRoutes(input: {
  app: FastifyInstance;
  templates: TemplateRepository;
  idempotency: IdempotencyRepository;
}): void {
  const { app, templates, idempotency } = input;

  app.get("/api/v1/templates", async (request) => {
    const query = parseTemplateListQuery(request.query);
    const result = templates.list(query);
    return {
      data: TemplateListSchema.parse({
        items: result.items,
        nextCursor:
          query.offset + result.items.length < result.total
            ? String(query.offset + query.limit)
            : null,
        total: result.total,
      }),
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/templates", async (request, reply) => {
    const body = CreateTemplateRequestSchema.parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, "/api/v1/templates");
    const hash = idempotency.requestHash(body);
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const detail = templates.create(randomUUID(), body, {
      routeScope: scope,
      key,
      requestHash: hash,
      requestId: requestIdFor(request),
    });
    return reply.code(201).send({ data: detail, requestId: requestIdFor(request) });
  });

  app.post("/api/v1/templates/from-source", async (request, reply) => {
    const body = TemplateFromSourceRequestSchema.parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, "/api/v1/templates/from-source");
    const hash = idempotency.requestHash(body);
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const requestId = requestIdFor(request);
    const result = await templates.fromSource({
      sourceVersionId: body.sourceVersionId,
      headingIds: body.selection.headingIds,
      kind: body.kind,
      templateId: randomUUID(),
      context: { routeScope: scope, key, requestHash: hash, requestId },
    });
    return reply.code(result.statusCode).send(result.response);
  });

  app.get("/api/v1/templates/:id", async (request) => {
    const params = z.strictObject({ id: z.uuid() }).parse(request.params);
    const query = z.strictObject({ versionId: z.uuid().optional() }).parse(request.query);
    return {
      data: TemplateDetailSchema.parse(templates.getDetail(params.id, query.versionId)),
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/templates/:id/versions", async (request, reply) => {
    const params = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = CreateTemplateVersionRequestSchema.parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, `/api/v1/templates/${params.id}/versions`);
    const hash = idempotency.requestHash({ id: params.id, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const detail = templates.createVersion(params.id, body, {
      routeScope: scope,
      key,
      requestHash: hash,
      requestId: requestIdFor(request),
    });
    return reply.code(201).send({ data: detail, requestId: requestIdFor(request) });
  });

  app.post("/api/v1/templates/:id/validate", async (request, reply) => {
    const params = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = ValidateTemplateRequestSchema.parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, `/api/v1/templates/${params.id}/validate`);
    const hash = idempotency.requestHash({ id: params.id, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const job = templates.validate(params.id, body, {
      routeScope: scope,
      key,
      requestHash: hash,
      requestId: requestIdFor(request),
    });
    return reply.code(202).send({
      data: ValidateTemplateJobSchema.parse(job),
      requestId: requestIdFor(request),
    });
  });

  app.post("/api/v1/templates/:id/archive", async (request, reply) => {
    const params = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = ArchiveTemplateRequestSchema.parse(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const scope = routeScope(request, `/api/v1/templates/${params.id}/archive`);
    const hash = idempotency.requestHash({ id: params.id, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(reply, existing, hash);
    const detail = templates.archive(params.id, body, {
      routeScope: scope,
      key,
      requestHash: hash,
      requestId: requestIdFor(request),
    });
    return reply.send({ data: detail, requestId: requestIdFor(request) });
  });
}

function parseTemplateListQuery(query: unknown): {
  q?: string;
  kind?: "feishu_doc" | "html_deck";
  status?: TemplateStatus;
  limit: number;
  offset: number;
} {
  const parsed = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    q: z.string().max(200).optional(),
    kind: z.enum(["feishu_doc", "html_deck"]).optional(),
    status: z.enum(["draft", "ready", "archived"]).optional(),
  }).parse(query);
  const offset = parsed.cursor === undefined || parsed.cursor === "" ? 0 : Number(parsed.cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "分页游标无效" });
  }
  return {
    limit: parsed.limit,
    offset,
    ...(parsed.q === undefined ? {} : { q: parsed.q }),
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.status === undefined ? {} : { status: parsed.status }),
  };
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

function routeScope(request: FastifyRequest, path: string): string {
  return `${request.method} ${path}`;
}
