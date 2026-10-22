import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RevisionListSchema,
  RevisionViewSchema,
  parseManualRevisionRequest,
  parseRestoreRevisionRequest,
  parseRevisionQuery,
} from "@dmall/contracts";
import { ApiError, requestIdFor } from "../errors.js";
import type { IdempotencyRepository } from "../idempotency.js";
import type { RevisionRepository } from "./revisions.js";

const ParamsSchema = z.strictObject({ id: z.uuid() });

export function registerAuthoringRoutes(input: {
  readonly app: FastifyInstance;
  readonly idempotency: IdempotencyRepository;
  readonly revisions: RevisionRepository;
}): void {
  const { app, idempotency, revisions } = input;

  app.post("/api/v1/renditions/:id/revisions", async (request, reply) => {
    const renditionId = ParamsSchema.parse(request.params).id;
    const body = parseManualRevisionRequest(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const result = revisions.saveManual({
      renditionId,
      request: body,
      routeScope: `POST /api/v1/renditions/${renditionId}/revisions`,
      key,
      requestHash: idempotency.requestHash({ renditionId, body }),
      requestId: requestIdFor(request),
    });
    return reply.code(result.statusCode).send(result.response);
  });

  app.get("/api/v1/renditions/:id/revisions", async (request) => {
    const renditionId = ParamsSchema.parse(request.params).id;
    const query = parseRevisionQuery(request.query);
    const offset = parseCursor(query.cursor);
    const result = revisions.list({
      renditionId,
      limit: query.limit,
      offset,
      ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
    });
    const requestId = requestIdFor(request);
    return query.revisionId === undefined
      ? { data: RevisionListSchema.parse(result), requestId }
      : { data: RevisionViewSchema.parse(result), requestId };
  });

  app.post("/api/v1/renditions/:id/restore", async (request, reply) => {
    const renditionId = ParamsSchema.parse(request.params).id;
    const body = parseRestoreRevisionRequest(request.body);
    const key = idempotency.requireKey(request.headers["idempotency-key"]);
    const result = revisions.restore({
      renditionId,
      request: body,
      routeScope: `POST /api/v1/renditions/${renditionId}/restore`,
      key,
      requestHash: idempotency.requestHash({ renditionId, body }),
      requestId: requestIdFor(request),
    });
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
