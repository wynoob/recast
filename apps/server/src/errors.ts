import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ErrorCode } from "@dmall/contracts";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(input: {
    statusCode: number;
    code: ErrorCode;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.details = input.details ?? {};
  }
}

export function requestIdFor(request: FastifyRequest): string {
  return request.id === "" ? randomUUID() : request.id;
}

export function sendApiError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: ApiError,
): void {
  reply
    .code(error.statusCode)
    .type("application/json; charset=utf-8")
    .send({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
      requestId: requestIdFor(request),
    });
}

export function sendUnexpectedError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
): void {
  request.log.error({ err: error }, "request failed");
  sendApiError(reply, request, new ApiError({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "服务内部错误",
  }));
}
