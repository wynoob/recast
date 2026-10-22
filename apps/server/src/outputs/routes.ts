import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AcceptPullRequestSchema,
  CreateExportRequestSchema,
  FeishuAttachRequestSchema,
  OutputJobStartSchema,
  ProjectBundleImportRequestSchema,
  PullRequestSchema,
} from "@dmall/contracts";
import { ApiError, requestIdFor } from "../errors.js";
import type { IdempotencyRepository } from "../idempotency.js";
import type { JobRepository } from "../job-repository.js";
import type { OutputRepository } from "./output-repository.js";

const UuidParamsSchema = z.strictObject({ id: z.uuid() });
const ArtifactParamsSchema = z.strictObject({ id: z.uuid(), artifactId: z.uuid() });

function writeContext(
  request: FastifyRequest,
  idempotency: IdempotencyRepository,
  requestId: string,
  route: string,
  body: unknown,
) {
  const key = idempotency.requireKey(request.headers["idempotency-key"]);
  return {
    routeScope: `${request.method} ${route}`,
    key,
    requestHash: idempotency.requestHash(body),
    requestId,
  };
}

export function registerOutputRoutes(input: {
  app: FastifyInstance;
  outputs: OutputRepository;
  idempotency: IdempotencyRepository;
  jobs: JobRepository;
}): void {
  const { app, outputs, idempotency, jobs } = input;

  app.post("/api/v1/exports", async (request, reply) => {
    const body = CreateExportRequestSchema.parse(request.body);
    const requestId = requestIdFor(request);
    const context = writeContext(request, idempotency, requestId, "/api/v1/exports", body);
    const result = await outputs.createExport(body, context);
    const parsed = OutputJobStartSchema.parse(
      (result.response as { data?: unknown } | null)?.data ?? null,
    );
    if (parsed.exportId === undefined) {
      throw new ApiError({ statusCode: 500, code: "INTERNAL_ERROR", message: "导出启动响应缺少 exportId" });
    }
    return reply.code(result.statusCode).send(result.response);
  });

  app.get("/api/v1/contents/:id/exports", async (request) => {
    const contentId = UuidParamsSchema.parse(request.params).id;
    const query = z.strictObject({
      renditionId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().optional(),
    }).parse(request.query);
    const offset = parseCursor(query.cursor);
    return {
      data: outputs.list({
        contentId,
        limit: query.limit,
        offset,
        ...(query.renditionId === undefined ? {} : { renditionId: query.renditionId }),
      }),
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/renditions/:id/exports", async (request) => {
    const renditionId = UuidParamsSchema.parse(request.params).id;
    const query = z.strictObject({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().optional(),
    }).parse(request.query);
    const contentId = outputs.contentIdForRendition(renditionId);
    return {
      data: outputs.list({
        contentId,
        renditionId,
        limit: query.limit,
        offset: parseCursor(query.cursor),
      }),
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/renditions/:id/output-preview", async (request) => {
    const renditionId = UuidParamsSchema.parse(request.params).id;
    const query = z.strictObject({ revisionId: z.uuid() }).parse(request.query);
    return {
      data: outputs.preview(renditionId, query.revisionId),
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/exports/:id", async (request) => {
    const id = UuidParamsSchema.parse(request.params).id;
    return { data: outputs.get(id), requestId: requestIdFor(request) };
  });

  app.get("/api/v1/exports/:id/artifacts/:artifactId/download", async (request, reply) => {
    const params = ArtifactParamsSchema.parse(request.params);
    const artifact = outputs.artifactPath(params.id, params.artifactId);
    reply.header("content-type", artifact.mime);
    reply.header(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
    );
    return reply.send(createReadStream(artifact.path));
  });

  app.post("/api/v1/exports/:id/retry", async (request, reply) => {
    const id = UuidParamsSchema.parse(request.params).id;
    const requestId = requestIdFor(request);
    const context = writeContext(request, idempotency, requestId, `/api/v1/exports/${id}/retry`, { id });
    const record = outputs.get(id);
    const snapshot = jobs.prepareRetry(record.jobId);
    const response = { data: snapshot, requestId };
    idempotency.save({
      routeScope: context.routeScope,
      key: context.key,
      requestHash: context.requestHash,
      statusCode: 200,
      requestId,
      response,
      resultRef: id,
    });
    return reply.send(response);
  });

  app.post("/api/v1/exports/:id/feishu/attach", async (request, reply) => {
    const id = UuidParamsSchema.parse(request.params).id;
    const body = FeishuAttachRequestSchema.parse(request.body);
    const requestId = requestIdFor(request);
    const context = writeContext(request, idempotency, requestId, `/api/v1/exports/${id}/feishu/attach`, body);
    const result = outputs.attachFeishu(
      id,
      { kind: "feishu_attach", documentId: body.documentId, documentUrl: body.documentUrl },
      context,
    );
    return reply.code(result.statusCode).send(result.response);
  });

  app.post("/api/v1/project-bundles/imports", async (request, reply) => {
    const body = ProjectBundleImportRequestSchema.parse(request.body);
    const requestId = requestIdFor(request);
    const context = writeContext(request, idempotency, requestId, "/api/v1/project-bundles/imports", body);
    const result = outputs.createBundleImport(body, context);
    return reply.code(result.statusCode).send(result.response);
  });

  app.get("/api/v1/project-bundles/imports/:id", async (request) => {
    const id = UuidParamsSchema.parse(request.params).id;
    return { data: outputs.getBundleImport(id), requestId: requestIdFor(request) };
  });

  app.post("/api/v1/feishu-bindings/:id/pull", async (request, reply) => {
    const bindingId = UuidParamsSchema.parse(request.params).id;
    const body = PullRequestSchema.parse(request.body);
    const requestId = requestIdFor(request);
    const context = writeContext(request, idempotency, requestId, `/api/v1/feishu-bindings/${bindingId}/pull`, body);
    const result = outputs.createPull(bindingId, body, context);
    return reply.code(result.statusCode).send(result.response);
  });

  app.get("/api/v1/pulls/:id", async (request) => {
    const id = UuidParamsSchema.parse(request.params).id;
    return { data: outputs.getPull(id), requestId: requestIdFor(request) };
  });

  app.post("/api/v1/pulls/:id/accept", async (request, reply) => {
    const id = UuidParamsSchema.parse(request.params).id;
    const body = AcceptPullRequestSchema.parse(request.body);
    const requestId = requestIdFor(request);
    const context = writeContext(request, idempotency, requestId, `/api/v1/pulls/${id}/accept`, body);
    const result = outputs.acceptPull(id, body, context);
    return reply.code(result.statusCode).send(result.response);
  });

  app.post("/api/v1/pulls/:id/reject", async (request, reply) => {
    const id = UuidParamsSchema.parse(request.params).id;
    const requestId = requestIdFor(request);
    const context = writeContext(request, idempotency, requestId, `/api/v1/pulls/${id}/reject`, { id });
    const result = outputs.rejectPull(id, context);
    return reply.code(result.statusCode).send(result.response);
  });
}

function parseCursor(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: "分页游标无效" });
  }
  return cursor;
}

