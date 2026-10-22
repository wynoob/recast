import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  CreateFactRequestSchema,
  CreateFactVersionRequestSchema,
  FactEntitySchema,
  FactPeriodSchema,
  FactValueSchema,
  FactVersionViewSchema,
  LocatorSchema,
  locatorKey,
  type CreateFactRequest,
  type CreateFactVersionRequest,
  type FactEntity,
  type Locator,
} from "@dmall/contracts";
import type { DocumentRepository } from "../documents/repository.js";
import { ApiError } from "../errors.js";
import type { IdempotencyRepository } from "../idempotency.js";
import type { WriteContext } from "../import-service.js";
import type { KeywordIndexService } from "../retrieval/index-service.js";

const FactRowSchema = z.strictObject({
  id: z.uuid(),
  canonical_key: z.string(),
  current_version_id: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  version_id: z.uuid(),
  version_number: z.int().positive(),
  value_json: z.string(),
  unit: z.string(),
  merchant_id: z.string().nullable(),
  period_json: z.string().nullable(),
  kind: z.enum(["measured", "estimated", "user_assertion"]),
  source_version_id: z.uuid(),
  source_locator_json: z.string(),
  status: z.enum(["unverified", "confirmed", "obsolete"]),
  index_text: z.string(),
  version_created_at: z.string(),
});

export class FactService {
  private readonly db: Database.Database;
  private readonly documents: DocumentRepository;
  private readonly index: KeywordIndexService;
  private readonly idempotency: IdempotencyRepository;

  constructor(input: {
    db: Database.Database;
    documents: DocumentRepository;
    index: KeywordIndexService;
    idempotency: IdempotencyRepository;
  }) {
    this.db = input.db;
    this.documents = input.documents;
    this.index = input.index;
    this.idempotency = input.idempotency;
  }

  createFact(body: CreateFactRequest, context: WriteContext): FactEntity {
    const request = CreateFactRequestSchema.parse(body);
    const requestHash = this.idempotency.requestHash(request);
    const replay = this.replay(context, requestHash, FactEntitySchema);
    if (replay !== null) return replay;
    this.assertLocator(request.version.sourceVersionId, request.version.sourceLocator);
    const result = this.db.transaction(() => {
      const duplicate = this.db
        .prepare("SELECT id FROM facts WHERE canonical_key = ?")
        .get(request.canonicalKey);
      if (duplicate !== undefined) {
        throw new ApiError({
          statusCode: 409,
          code: "FACT_CONFLICT",
          message: "事实 canonicalKey 已存在",
        });
      }
      const now = new Date().toISOString();
      const factId = randomUUID();
      const versionId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO facts(id, canonical_key, current_version_id, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?)`,
        )
        .run(factId, request.canonicalKey, now, now);
      this.insertVersion({
        factId,
        versionId,
        versionNumber: 1,
        request: request.version,
        now,
      });
      this.db
        .prepare("UPDATE facts SET current_version_id = ? WHERE id = ?")
        .run(versionId, factId);
      const entity = this.requireFact(factId);
      this.index.rebuild();
      this.idempotency.save({
        routeScope: context.scope,
        key: context.key,
        requestHash,
        statusCode: 201,
        requestId: context.requestId,
        response: { data: entity, requestId: context.requestId },
        resultRef: factId,
      });
      return entity;
    })();
    return result;
  }

  createVersion(
    factId: string,
    body: CreateFactVersionRequest,
    context: WriteContext,
  ): FactEntity {
    const request = CreateFactVersionRequestSchema.parse(body);
    const requestHash = this.idempotency.requestHash({ factId, request });
    const replay = this.replay(context, requestHash, FactEntitySchema);
    if (replay !== null) return replay;
    this.assertLocator(request.version.sourceVersionId, request.version.sourceLocator);
    return this.db.transaction(() => {
      const fact = z
        .strictObject({
          current_version_id: z.uuid(),
          current_version_number: z.int().positive(),
        })
        .parse(
          this.db
            .prepare(
              `SELECT f.current_version_id, fv.version_number AS current_version_number
               FROM facts f JOIN fact_versions fv ON fv.id = f.current_version_id
               WHERE f.id = ?`,
            )
            .get(factId),
        );
      if (fact.current_version_id !== request.expectedVersionId) {
        throw new ApiError({
          statusCode: 409,
          code: "FACT_VERSION_CONFLICT",
          message: "事实已被修改，请刷新后重试",
          details: { currentVersionId: fact.current_version_id },
        });
      }
      const now = new Date().toISOString();
      const versionId = randomUUID();
      this.insertVersion({
        factId,
        versionId,
        versionNumber: fact.current_version_number + 1,
        request: request.version,
        now,
      });
      this.db
        .prepare("UPDATE facts SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .run(versionId, now, factId);
      const entity = this.requireFact(factId);
      this.index.rebuild();
      this.idempotency.save({
        routeScope: context.scope,
        key: context.key,
        requestHash,
        statusCode: 201,
        requestId: context.requestId,
        response: { data: entity, requestId: context.requestId },
        resultRef: factId,
      });
      return entity;
    })();
  }

  requireFact(factId: string): FactEntity {
    const raw = this.db
      .prepare(
        `SELECT f.id, f.canonical_key, f.current_version_id, f.created_at, f.updated_at,
                fv.id AS version_id, fv.version_number, fv.value_json, fv.unit,
                fv.merchant_id, fv.period_json, fv.kind, fv.source_version_id,
                fv.source_locator_json, fv.status, fv.index_text,
                fv.created_at AS version_created_at
         FROM facts f
         JOIN fact_versions fv ON fv.id = f.current_version_id
         WHERE f.id = ?`,
      )
      .get(factId);
    if (raw === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "事实不存在" });
    }
    return toFactEntity(FactRowSchema.parse(raw));
  }

  getFact(factId: string): FactEntity | null {
    try {
      return this.requireFact(factId);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) return null;
      throw error;
    }
  }

  private insertVersion(input: {
    factId: string;
    versionId: string;
    versionNumber: number;
    request: CreateFactRequest["version"];
    now: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO fact_versions(
          id, fact_id, value_json, unit, merchant_id, period_json, kind,
          source_locator_json, status, created_at, version_number,
          source_version_id, index_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.versionId,
        input.factId,
        JSON.stringify(input.request.value),
        input.request.unit,
        input.request.merchantId,
        input.request.period === null ? null : JSON.stringify(input.request.period),
        input.request.kind,
        JSON.stringify(input.request.sourceLocator),
        input.request.status,
        input.now,
        input.versionNumber,
        input.request.sourceVersionId,
        input.request.indexText,
      );
  }

  private assertLocator(sourceVersionId: string, locator: Locator): void {
    const version = this.db
      .prepare("SELECT id FROM source_versions WHERE id = ?")
      .get(sourceVersionId);
    if (version === undefined) {
      throw new ApiError({
        statusCode: 422,
        code: "UNKNOWN_REFERENCE",
        message: "事实来源版本不存在",
      });
    }
    const document = this.documents.getSourceDocument(sourceVersionId);
    const keys = new Set<string>();
    for (const section of document?.sections ?? []) {
      keys.add(locatorKey(section.locator));
      for (const block of section.blocks) keys.add(locatorKey(block.locator));
    }
    const occurrences = z
      .array(z.strictObject({ locator_json: z.string() }))
      .parse(
        this.db
          .prepare("SELECT locator_json FROM occurrences WHERE source_version_id = ?")
          .all(sourceVersionId),
      );
    for (const occurrence of occurrences) {
      keys.add(locatorKey(LocatorSchema.parse(JSON.parse(occurrence.locator_json))));
    }
    if (!keys.has(locatorKey(locator))) {
      throw new ApiError({
        statusCode: 422,
        code: "UNKNOWN_REFERENCE",
        message: "事实定位不属于指定来源版本",
      });
    }
  }

  private replay<T>(
    context: WriteContext,
    requestHash: string,
    schema: z.ZodType<T>,
  ): T | null {
    const existing = this.idempotency.find(context.scope, context.key);
    if (existing === null) return null;
    if (existing.requestHash !== requestHash) {
      throw new ApiError({
        statusCode: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "同一 Idempotency-Key 对应了不同请求",
      });
    }
    return z
      .strictObject({ data: schema, requestId: z.string() })
      .parse(existing.response).data;
  }
}

function toFactEntity(row: z.infer<typeof FactRowSchema>): FactEntity {
  return FactEntitySchema.parse({
    id: row.id,
    canonicalKey: row.canonical_key,
    currentVersionId: row.current_version_id,
    currentVersion: FactVersionViewSchema.parse({
      id: row.version_id,
      factId: row.id,
      version: row.version_number,
      value: FactValueSchema.parse(JSON.parse(row.value_json)),
      unit: row.unit,
      merchantId: row.merchant_id,
      period: row.period_json === null ? null : FactPeriodSchema.parse(JSON.parse(row.period_json)),
      kind: row.kind,
      sourceVersionId: row.source_version_id,
      sourceLocator: LocatorSchema.parse(JSON.parse(row.source_locator_json)),
      status: row.status,
      indexText: row.index_text,
      createdAt: row.version_created_at,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
