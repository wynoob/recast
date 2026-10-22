import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  RemoteOperationKindSchema,
  RemoteOperationSchema,
  RemoteOperationStateSchema,
  type RemoteOperation,
  type RemoteOperationKind,
} from "@dmall/contracts";

const RemoteRowSchema = z.strictObject({
  operation_id: z.uuid(),
  attempt: z.int().positive(),
  lease_generation: z.int().positive(),
  job_id: z.uuid(),
  kind: RemoteOperationKindSchema,
  state: RemoteOperationStateSchema,
  request_hash: z.string(),
  remote_client_token: z.string().nullable(),
  response_json: z.string().nullable(),
});

export class RemoteOperationRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  prepare(input: {
    operationId?: string;
    jobId: string;
    attempt: number;
    leaseGeneration: number;
    kind: RemoteOperationKind;
    requestHash: string;
    remoteClientToken: string | null;
  }): RemoteOperation {
    const operationId = input.operationId ?? randomUUID();
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      `SELECT operation_id, attempt, lease_generation, job_id, kind, state, request_hash,
              remote_client_token, response_json
       FROM remote_operations WHERE operation_id = ? AND attempt = ? AND lease_generation = ?`,
    ).get(operationId, input.attempt, input.leaseGeneration);
    if (existing !== undefined) {
      const parsed = this.parse(existing);
      if (
        parsed.job_id !== input.jobId ||
        parsed.kind !== input.kind ||
        parsed.request_hash !== input.requestHash
      ) {
        throw new Error("remote operation id reused with different request");
      }
      return this.get(operationId, input.attempt, input.leaseGeneration);
    }
    this.db
      .prepare(
        `INSERT INTO remote_operations
          (operation_id, attempt, lease_generation, job_id, kind, state, request_hash,
           remote_client_token, response_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, NULL, ?, ?)`,
      )
      .run(
        operationId,
        input.attempt,
        input.leaseGeneration,
        input.jobId,
        input.kind,
        input.requestHash,
        input.remoteClientToken,
        now,
        now,
      );
    return this.get(operationId, input.attempt, input.leaseGeneration);
  }

  markDispatched(input: {
    operationId: string;
    attempt: number;
    leaseGeneration: number;
    requestHash: string;
  }): RemoteOperation {
    const current = this.get(input.operationId, input.attempt, input.leaseGeneration);
    if (current.requestHash !== input.requestHash || current.state !== "prepared") {
      throw new Error("remote operation dispatch precondition failed");
    }
    this.db
      .prepare(
        `UPDATE remote_operations SET state = 'dispatched', updated_at = ?
         WHERE operation_id = ? AND attempt = ? AND lease_generation = ?`,
      )
      .run(new Date().toISOString(), input.operationId, input.attempt, input.leaseGeneration);
    return this.get(input.operationId, input.attempt, input.leaseGeneration);
  }

  markUnknown(input: {
    operationId: string;
    attempt: number;
    leaseGeneration: number;
  }): RemoteOperation {
    this.db
      .prepare(
        `UPDATE remote_operations SET state = 'unknown', updated_at = ?
         WHERE operation_id = ? AND attempt = ? AND lease_generation = ? AND state = 'dispatched'`,
      )
      .run(new Date().toISOString(), input.operationId, input.attempt, input.leaseGeneration);
    return this.get(input.operationId, input.attempt, input.leaseGeneration);
  }

  confirm(input: {
    operationId: string;
    attempt: number;
    leaseGeneration: number;
    response: unknown;
  }): RemoteOperation {
    this.db
      .prepare(
        `UPDATE remote_operations SET state = 'confirmed', response_json = ?, updated_at = ?
         WHERE operation_id = ? AND attempt = ? AND lease_generation = ? AND state = 'dispatched'`,
      )
      .run(
        JSON.stringify(input.response),
        new Date().toISOString(),
        input.operationId,
        input.attempt,
        input.leaseGeneration,
      );
    return this.get(input.operationId, input.attempt, input.leaseGeneration);
  }

  get(operationId: string, attempt: number, leaseGeneration: number): RemoteOperation {
    const row = this.db
      .prepare(
        `SELECT operation_id, attempt, lease_generation, job_id, kind, state,
                request_hash, remote_client_token, response_json
         FROM remote_operations WHERE operation_id = ? AND attempt = ? AND lease_generation = ?`,
      )
      .get(operationId, attempt, leaseGeneration);
    if (row === undefined) throw new Error("remote operation not found");
    const parsed = this.parse(row);
    return RemoteOperationSchema.parse({
      schemaVersion: 1,
      operationId: parsed.operation_id,
      jobId: parsed.job_id,
      attempt: parsed.attempt,
      leaseGeneration: parsed.lease_generation,
      kind: parsed.kind,
      state: parsed.state,
      requestHash: parsed.request_hash,
      remoteClientToken: parsed.remote_client_token,
      ...(parsed.state === "unknown"
        ? {
            recovery: {
              kind: "waiting_input_remote_result_unknown" as const,
              message: "远端结果未知，必须人工核对后才能继续",
            },
          }
        : {}),
    });
  }

  private parse(row: unknown): z.infer<typeof RemoteRowSchema> {
    return RemoteRowSchema.parse(row);
  }
}
