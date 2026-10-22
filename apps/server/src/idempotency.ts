import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { IdempotencyKeySchema } from "@dmall/contracts";
import { ApiError } from "./errors.js";

const IdempotencyRowSchema = z.strictObject({
  request_hash: z.string(),
  status_code: z.int(),
  request_id: z.string(),
  response_json: z.string(),
});

export interface IdempotencyRecord {
  requestHash: string;
  statusCode: number;
  requestId: string;
  response: unknown;
}

export class IdempotencyRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  requireKey(value: string | string[] | undefined): string {
    if (typeof value !== "string") {
      throw new ApiError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "写请求必须提供 UUID 格式的 Idempotency-Key",
      });
    }
    const parsed = IdempotencyKeySchema.safeParse(value);
    if (!parsed.success) {
      throw new ApiError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "Idempotency-Key 必须是 UUID",
      });
    }
    return parsed.data;
  }

  find(routeScope: string, key: string): IdempotencyRecord | null {
    const row = this.db
      .prepare(
        `SELECT request_hash, status_code, request_id, response_json
         FROM idempotency_keys WHERE route_scope = ? AND key = ?`,
      )
      .get(routeScope, key);
    if (row === undefined) return null;
    const parsed = IdempotencyRowSchema.parse(row);
    return {
      requestHash: parsed.request_hash,
      statusCode: parsed.status_code,
      requestId: parsed.request_id,
      response: JSON.parse(parsed.response_json) as unknown,
    };
  }

  save(input: {
    routeScope: string;
    key: string;
    requestHash: string;
    statusCode: number;
    requestId: string;
    response: unknown;
    resultRef: string | null;
  }): void {
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO idempotency_keys
          (route_scope, key, request_hash, status_code, request_id, response_json, result_ref, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.routeScope,
        input.key,
        input.requestHash,
        input.statusCode,
        input.requestId,
        JSON.stringify(input.response),
        input.resultRef,
        now.toISOString(),
        new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      );
  }

  requestHash(body: unknown): string {
    return createHash("sha256").update(stableJson(body)).digest("hex");
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]);
    return Object.fromEntries(entries);
  }
  return value;
}
