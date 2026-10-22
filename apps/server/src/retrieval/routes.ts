import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateFactRequestSchema,
  CreateFactVersionRequestSchema,
  SearchRequestSchema,
} from "@dmall/contracts";
import { ApiError } from "../errors.js";
import type { FactService } from "../facts/fact-service.js";
import type { IdempotencyRepository } from "../idempotency.js";
import type { WriteContext } from "../import-service.js";
import type { RetrievalService } from "./retrieval-service.js";

export function registerRetrievalRoutes(input: {
  app: FastifyInstance;
  retrieval: RetrievalService;
  facts: FactService;
  idempotency: IdempotencyRepository;
  requestIdFor: (request: FastifyRequest) => string;
}): void {
  const { app, retrieval, facts, idempotency, requestIdFor } = input;

  app.post("/api/v1/search", async (request) => {
    const body = SearchRequestSchema.parse(request.body);
    const context = writeContext(
      request,
      idempotency,
      requestIdFor(request),
      "/api/v1/search",
    );
    return {
      data: retrieval.search(body, context),
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/selections/:id", async (request) => {
    const { id } = z.strictObject({
      id: z.union([z.uuid(), z.string().regex(/^sel1:[A-Za-z0-9_-]+$/)]),
    }).parse(request.params);
    return { data: retrieval.getSelection(id), requestId: requestIdFor(request) };
  });

  app.post("/api/v1/facts", async (request, reply) => {
    const body = CreateFactRequestSchema.parse(request.body);
    const context = writeContext(
      request,
      idempotency,
      requestIdFor(request),
      "/api/v1/facts",
    );
    return reply.code(201).send({
      data: facts.createFact(body, context),
      requestId: requestIdFor(request),
    });
  });

  app.post("/api/v1/facts/:id/versions", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = CreateFactVersionRequestSchema.parse(request.body);
    const context = writeContext(
      request,
      idempotency,
      requestIdFor(request),
      `/api/v1/facts/${id}/versions`,
    );
    return reply.code(201).send({
      data: facts.createVersion(id, body, context),
      requestId: requestIdFor(request),
    });
  });

  app.get("/api/v1/facts/:id", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const fact = facts.getFact(id);
    if (fact === null) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "事实不存在" });
    }
    return { data: fact, requestId: requestIdFor(request) };
  });
}

function writeContext(
  request: FastifyRequest,
  idempotency: IdempotencyRepository,
  requestId: string,
  path: string,
): WriteContext {
  return {
    key: idempotency.requireKey(request.headers["idempotency-key"]),
    scope: `${request.method} ${path}`,
    requestId,
  };
}
