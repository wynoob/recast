import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AssetAvailabilitySchema,
  ImportCreateRequestSchema,
  ImportRetryRequestSchema,
  ListSourcesQuerySchema,
  PatchAssetRequestSchema,
  ScanCreateRequestSchema,
} from "@dmall/contracts";
import { ApiError } from "./errors.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type { ImportService, WriteContext } from "./import-service.js";
import type { LibraryRepository } from "./library-repository.js";
import type { UploadService } from "./upload-service.js";

const PageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const ScanItemsQuerySchema = PageQuerySchema.extend({
  status: z.enum(["candidate", "excluded", "unsupported", "unreadable"]).optional(),
  kind: z.enum(["image", "gif", "video", "markdown", "pdf", "pptx", "html", "html_zip", "unsupported"]).optional(),
});

const AssetListQuerySchema = PageQuerySchema.extend({
  q: z.string().max(200).optional(),
  type: z.enum(["image", "gif", "video"]).optional(),
  state: AssetAvailabilitySchema.optional(),
  merchant: z.string().max(200).optional(),
});

const SourceQuerySchema = z.strictObject({ versionId: z.uuid().optional() });

export function registerImportRoutes(input: {
  app: FastifyInstance;
  imports: ImportService;
  uploads: UploadService;
  library: LibraryRepository;
  idempotency: IdempotencyRepository;
  requestIdFor: (request: FastifyRequest) => string;
}): void {
  const { app, imports, uploads, library, idempotency, requestIdFor } = input;

  app.post("/api/v1/uploads", async (request, reply) => {
    const context = writeContext(request, idempotency, requestIdFor(request), "/api/v1/uploads");
    const result = await uploads.upload(request, context);
    return reply.code(201).send({ data: result, requestId: requestIdFor(request) });
  });

  app.post("/api/v1/imports/scan", async (request, reply) => {
    const body = ScanCreateRequestSchema.parse(request.body);
    const context = writeContext(
      request,
      idempotency,
      requestIdFor(request),
      "/api/v1/imports/scan",
    );
    const result = await imports.createScan(body, context);
    return reply.code(202).send({ data: result, requestId: requestIdFor(request) });
  });

  app.get("/api/v1/imports/scans/:scanId", async (request) => {
    const { scanId } = z.strictObject({ scanId: z.uuid() }).parse(request.params);
    return { data: imports.getScanDetail(scanId), requestId: requestIdFor(request) };
  });

  app.get("/api/v1/imports/scans/:scanId/items", async (request) => {
    const { scanId } = z.strictObject({ scanId: z.uuid() }).parse(request.params);
    const query = ScanItemsQuerySchema.parse(request.query);
    const offset = parseCursor(query.cursor);
    const result = imports.listScanItems(scanId, {
      limit: query.limit,
      offset,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
    });
    return {
      data: {
        items: result.items,
        nextCursor: offset + result.items.length < result.total ? String(offset + query.limit) : null,
        total: result.total,
      },
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/imports", async (request, reply) => {
    const body = ImportCreateRequestSchema.parse(request.body);
    const context = writeContext(request, idempotency, requestIdFor(request), "/api/v1/imports");
    const result = await imports.createImport(body, context);
    return reply.code(202).send({ data: result, requestId: requestIdFor(request) });
  });

  app.get("/api/v1/imports/:id", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const query = PageQuerySchema.parse(request.query);
    return {
      data: imports.getImportDetail(id, {
        limit: query.limit,
        offset: parseCursor(query.cursor),
      }),
      requestId: requestIdFor(request),
    };
  });

  app.post("/api/v1/imports/:id/retry", async (request, reply) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = ImportRetryRequestSchema.parse(request.body);
    const context = writeContext(
      request,
      idempotency,
      requestIdFor(request),
      `/api/v1/imports/${id}/retry`,
    );
    const result = imports.retryImport(id, body.itemIds, context);
    return reply.code(202).send({ data: result, requestId: requestIdFor(request) });
  });

  app.get("/api/v1/assets", async (request) => {
    const query = AssetListQuerySchema.parse(request.query);
    const offset = parseCursor(query.cursor);
    const result = await library.listAssets({
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.merchant === undefined ? {} : { merchant: query.merchant }),
      limit: query.limit,
      offset,
    });
    return {
      data: {
        items: result.items,
        nextCursor: offset + result.items.length < result.total ? String(offset + query.limit) : null,
        total: result.total,
        groupCounts: result.groupCounts,
      },
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/assets/:id", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    return { data: await library.getAssetDetail(id), requestId: requestIdFor(request) };
  });

  app.patch("/api/v1/assets/:id", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const body = PatchAssetRequestSchema.parse(request.body);
    const context = writeContext(
      request,
      idempotency,
      requestIdFor(request),
      `/api/v1/assets/${id}`,
    );
    return library.patchAsset(id, body, context);
  });

  app.get("/api/v1/sources", async (request) => {
    const query = ListSourcesQuerySchema.parse(request.query);
    const offset = parseCursor(query.cursor);
    const result = library.listSources({
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      limit: query.limit,
      offset,
    });
    return {
      data: {
        items: result.items,
        nextCursor: offset + result.items.length < result.total ? String(offset + query.limit) : null,
        total: result.total,
      },
      requestId: requestIdFor(request),
    };
  });

  app.get("/api/v1/sources/:id", async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const query = SourceQuerySchema.parse(request.query);
    return {
      data: library.getSourceContext(id, query.versionId),
      requestId: requestIdFor(request),
    };
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

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: "分页游标无效",
    });
  }
  return offset;
}
