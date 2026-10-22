import { randomUUID } from "node:crypto";
import {
  ApiErrorSchema,
  EvidenceSelectRequestSchema,
  parseManualRevisionRequest,
  parseRestoreRevisionRequest,
  type CreateContentRequest,
  type ManualRevisionRequest,
  type RestoreRevisionRequest,
} from "@dmall/contracts";
import { ZodError } from "zod";
import {
  ContentRepository,
  parseCreateContent,
} from "../../apps/server/src/content-repository.js";
import { ApiError } from "../../apps/server/src/errors.js";
import { IdempotencyRepository } from "../../apps/server/src/idempotency.js";
import { RevisionRepository } from "../../apps/server/src/authoring/revisions.js";
import type { T02cTestApp } from "./t02c-test-helpers.js";

type InternalApp = Pick<T02cTestApp, "context">;

export type InternalReply = {
  readonly status: number;
  readonly body: unknown;
};

export function createInternalContent(
  app: InternalApp,
  input: CreateContentRequest,
  key = randomUUID(),
  requestId = "internal-create-content",
): InternalReply {
  const idempotency = new IdempotencyRepository(app.context.database.db);
  const contents = new ContentRepository(app.context.database.db, idempotency);
  const scope = "internal ContentRepository.create /contents";
  try {
    const body = parseCreateContent(input);
    const requestHash = idempotency.requestHash(body);
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(existing, requestHash);
    const detail = contents.create(body, { routeScope: scope, key, requestHash, requestId });
    return { status: 201, body: { data: detail, requestId } };
  } catch (error) {
    return normalizeInternalError(error, requestId);
  }
}

export function saveInternalRevision(
  app: InternalApp,
  renditionId: string,
  input: ManualRevisionRequest,
  key = randomUUID(),
  requestId = "internal-save-revision",
): InternalReply {
  try {
    const body = parseManualRevisionRequest(input);
    const idempotency = new IdempotencyRepository(app.context.database.db);
    const revisions = new RevisionRepository(app.context.database.db, idempotency);
    const result = revisions.saveManual({
      renditionId,
      request: body,
      routeScope: `internal RevisionRepository.saveManual /renditions/${renditionId}`,
      key,
      requestHash: idempotency.requestHash({ renditionId, body }),
      requestId,
    });
    return { status: result.statusCode, body: result.response };
  } catch (error) {
    return normalizeInternalError(error, requestId);
  }
}

export function restoreInternalRevision(
  app: InternalApp,
  renditionId: string,
  input: RestoreRevisionRequest,
  key = randomUUID(),
  requestId = "internal-restore-revision",
): InternalReply {
  try {
    const body = parseRestoreRevisionRequest(input);
    const idempotency = new IdempotencyRepository(app.context.database.db);
    const revisions = new RevisionRepository(app.context.database.db, idempotency);
    const result = revisions.restore({
      renditionId,
      request: body,
      routeScope: `internal RevisionRepository.restore /renditions/${renditionId}`,
      key,
      requestHash: idempotency.requestHash({ renditionId, body }),
      requestId,
    });
    return { status: result.statusCode, body: result.response };
  } catch (error) {
    return normalizeInternalError(error, requestId);
  }
}

export function selectInternalEvidence(
  app: InternalApp,
  contentId: string,
  input: unknown,
  key = randomUUID(),
  requestId = "internal-select-evidence",
): InternalReply {
  const idempotency = new IdempotencyRepository(app.context.database.db);
  const scope = `internal AuthoringEvidenceService.select /contents/${contentId}/evidence`;
  try {
    const body = EvidenceSelectRequestSchema.parse(input);
    const requestHash = idempotency.requestHash({ contentId, body });
    const existing = idempotency.find(scope, key);
    if (existing !== null) return replay(existing, requestHash);
    const items = app.context.authoringEvidence.select(contentId, body.selectionHandles);
    const response = { data: { items }, requestId };
    idempotency.save({
      routeScope: scope,
      key,
      requestHash,
      statusCode: 201,
      requestId,
      response,
      resultRef: null,
    });
    return { status: 201, body: response };
  } catch (error) {
    return normalizeInternalError(error, requestId);
  }
}

function replay(
  existing: { requestHash: string; statusCode: number; response: unknown },
  requestHash: string,
): InternalReply {
  if (existing.requestHash !== requestHash) {
    throw new ApiError({
      statusCode: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message: "同一 Idempotency-Key 对应了不同请求",
    });
  }
  return { status: existing.statusCode, body: existing.response };
}

function normalizeInternalError(error: unknown, requestId: string): InternalReply {
  if (error instanceof ApiError) {
    return {
      status: error.statusCode,
      body: ApiErrorSchema.parse({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        },
        requestId,
      }),
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: ApiErrorSchema.parse({
        error: {
          code: "VALIDATION_ERROR",
          message: "请求字段不符合契约",
          retryable: false,
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          },
        },
        requestId,
      }),
    };
  }
  throw error;
}
