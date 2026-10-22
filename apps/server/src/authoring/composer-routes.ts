import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CompositionViewSchema, ConfirmCommandSchema, ResumeCommandSchema, SubmitCommandSchema } from "@dmall/contracts";
import type { IdempotencyRepository } from "../idempotency.js";
import { ApiError, requestIdFor } from "../errors.js";
import type { Composer } from "./composer.js";

export function registerComposerRoutes(input: { app: FastifyInstance; composer: Composer; idempotency: IdempotencyRepository; kick: () => void }): void {
  const { app, composer, idempotency } = input;
  app.get("/api/v1/compositions/:contentId", async (request) => {
    const { contentId } = z.strictObject({ contentId: z.uuid() }).parse(request.params);
    return { data: CompositionViewSchema.parse(await composer.read(contentId)), requestId: requestIdFor(request) };
  });
  for (const operation of ["submit", "confirm", "resume-delivery"] as const) {
    const path = operation === "resume-delivery" ? "/api/v1/compositions/:contentId/resume-delivery" : `/api/v1/compositions/${operation}`;
    app.post(path, async (request, reply) => {
      const body = operation === "submit" ? SubmitCommandSchema.parse(request.body)
        : operation === "confirm" ? ConfirmCommandSchema.parse(request.body)
        : ResumeCommandSchema.parse({ ...z.record(z.string(), z.unknown()).parse(request.body), ...z.strictObject({ contentId: z.uuid() }).parse(request.params) });
      const key = idempotency.requireKey(request.headers["idempotency-key"]);
      const scope = `POST ${path}`;
      const requestHash = idempotency.requestHash({ operation, body });
      const existing = idempotency.find(scope, key);
      if (existing !== null) {
        if (existing.requestHash !== requestHash) throw new ApiError({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT", message: "同一动作键对应不同请求" });
        return reply.code(existing.statusCode).send(existing.response);
      }
      const identity = { id: key, requestHash };
      const view = operation === "submit" ? await composer.submit(SubmitCommandSchema.parse(body), identity)
        : operation === "confirm" ? await composer.confirm(ConfirmCommandSchema.parse(body), identity)
        : await composer.resumeDelivery(ResumeCommandSchema.parse(body), identity);
      const response = { data: CompositionViewSchema.parse(view), requestId: requestIdFor(request) };
      const statusCode = operation === "resume-delivery" ? 200 : 202;
      idempotency.save({ routeScope: scope, key, requestHash, statusCode, requestId: response.requestId, response, resultRef: view.contentId });
      input.kick();
      return reply.code(statusCode).send(response);
    });
  }
}
