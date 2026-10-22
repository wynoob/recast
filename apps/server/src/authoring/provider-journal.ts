import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  JobInputSchema,
  type WorkerCallIntent,
  type WorkerCallResult,
  type WorkerFence,
} from "@dmall/contracts";
import { ApiError } from "../errors.js";
import { stableJson } from "./revision-commit.js";

const JobRowSchema = z.strictObject({
  input_hash: z.string(),
  input_json: z.string(),
  state: z.string(),
  attempt: z.int().positive(),
  lease_generation: z.int().positive(),
  lease_owner: z.string(),
  cancel_requested: z.int().min(0).max(1),
});

const CallRowSchema = z.strictObject({
  attempt_id: z.uuid(),
  job_id: z.uuid(),
  logical_call_id: z.string(),
  request_hash: z.string(),
  state: z.enum(["prepared", "dispatched", "completed", "cancelled", "unknown", "failed"]),
  fence_attempt: z.int().positive(),
  fence_lease_generation: z.int().positive(),
  lease_owner: z.string(),
  response_hash: z.string().nullable(),
  request_envelope_json: z.string(),
});

export interface PermitView {
  attemptId: string;
  logicalCallId: string;
  requestHash: string;
  retransmit: boolean;
}

export class ProviderJournal {
  constructor(private readonly db: Database.Database) {}

  intent(fence: WorkerFence, intent: WorkerCallIntent): PermitView {
    const job = this.currentJob(fence);
    const input = JobInputSchema.parse(JSON.parse(job.input_json) as unknown);
    if (
      input.jobType !== "authoring_provider" &&
      input.jobType !== "authoring_transcription" &&
      input.jobType !== "authoring_probe"
    ) {
      throw new ApiError({
        statusCode: 409,
        code: "VALIDATION_ERROR",
        message: "当前任务不允许模型调用",
      });
    }
    const computedHash = `rh1:${sha256(stableJson(intent.requestEnvelope))}`;
    if (
      computedHash !== intent.requestHash ||
      stableJson(intent.requestEnvelope) !== stableJson(input.requestEnvelope)
    ) {
      throw new ApiError({
        statusCode: 422,
        code: "CALL_IDENTITY_CONFLICT",
        message: "模型请求 envelope hash 不一致",
      });
    }
    const expectedPurpose =
      input.jobType === "authoring_transcription"
        ? "transcription"
        : input.jobType === "authoring_probe"
          ? "probe"
          : input.task === "plan"
            ? "planning"
            : input.task === "revise"
              ? "revision"
              : "generation";
    if (intent.purpose !== expectedPurpose) {
      throw new ApiError({
        statusCode: 422,
        code: "CALL_IDENTITY_CONFLICT",
        message: "模型调用 purpose 与任务不匹配",
      });
    }
    const attemptOrdinal = job.attempt - 1;
    const reusable = this.db.prepare(
      `SELECT attempt_id, logical_call_id, request_hash
       FROM provider_calls
       WHERE job_id = ? AND state = 'prepared' AND purpose = ?
         AND call_ordinal = ? AND request_hash = ?
       ORDER BY prepared_at LIMIT 1`,
    ).get(fence.jobId, intent.purpose, intent.callOrdinal, intent.requestHash);
    if (reusable !== undefined) {
      const call = z.strictObject({
        attempt_id: z.uuid(),
        logical_call_id: z.string(),
        request_hash: z.string(),
      }).parse(reusable);
      const now = new Date().toISOString();
      const dispatched = this.db.transaction(() => this.db.prepare(
        `UPDATE provider_calls
         SET fence_attempt = ?, fence_lease_generation = ?, lease_owner = ?,
             state = 'dispatched', dispatched_at = ?, updated_at = ?
         WHERE attempt_id = ? AND state = 'prepared'`,
      ).run(
        fence.attempt,
        fence.leaseGeneration,
        fence.leaseOwner,
        now,
        now,
        call.attempt_id,
      )).immediate();
      if (dispatched.changes === 1) {
        return {
          attemptId: call.attempt_id,
          logicalCallId: call.logical_call_id,
          requestHash: call.request_hash,
          retransmit: false,
        };
      }
    }
    const logicalCallId = `call1:${sha256(stableJson({
      jobId: fence.jobId,
      inputHash: job.input_hash,
      purpose: intent.purpose,
      callOrdinal: intent.callOrdinal,
      attemptOrdinal,
    }))}`;
    const existing = this.db.prepare(
      "SELECT attempt_id, job_id, logical_call_id, request_hash, state, fence_attempt, fence_lease_generation, lease_owner, response_hash, request_envelope_json FROM provider_calls WHERE job_id = ? AND logical_call_id = ?",
    ).get(fence.jobId, logicalCallId);
    if (existing !== undefined) {
      const call = CallRowSchema.parse(existing);
      if (call.request_hash !== intent.requestHash) {
        throw new ApiError({
          statusCode: 409,
          code: "CALL_IDENTITY_CONFLICT",
          message: "同一逻辑调用对应了不同请求",
        });
      }
      if (call.state === "completed") {
        throw new ApiError({
          statusCode: 409,
          code: "MODEL_RESULT_UNKNOWN",
          message: "该逻辑调用已完成，不会再次发送",
          details: { attemptId: call.attempt_id, state: call.state },
        });
      }
      if (call.state !== "dispatched") {
        throw new ApiError({
          statusCode: 409,
          code: "MODEL_RESULT_UNKNOWN",
          message: "该逻辑调用不能自动重新发送",
          details: { attemptId: call.attempt_id, state: call.state },
        });
      }
      if (
        call.fence_attempt !== fence.attempt ||
        call.fence_lease_generation !== fence.leaseGeneration ||
        call.lease_owner !== fence.leaseOwner
      ) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_STALE_LEASE",
          message: "旧租约不能重发已派发的模型请求",
        });
      }
      return {
        attemptId: call.attempt_id,
        logicalCallId: call.logical_call_id,
        requestHash: call.request_hash,
        retransmit: true,
      };
    }

    const attemptId = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO provider_calls(
          attempt_id, job_id, logical_call_id, request_hash, purpose, call_ordinal,
          attempt_ordinal, role, provider_id, model_id, fence_attempt,
          fence_lease_generation, lease_owner, state, request_envelope_json, prepared_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`,
      ).run(
        attemptId,
        fence.jobId,
        logicalCallId,
        intent.requestHash,
        intent.purpose,
        intent.callOrdinal,
        attemptOrdinal,
        input.provider.role,
        input.provider.providerId,
        input.provider.modelId,
        fence.attempt,
        fence.leaseGeneration,
        fence.leaseOwner,
        JSON.stringify(intent.requestEnvelope),
        now,
        now,
      );
    }).immediate();

    const dispatched = this.db.transaction(() => this.db.prepare(
      `UPDATE provider_calls
       SET state = 'dispatched', dispatched_at = ?, updated_at = ?
       WHERE attempt_id = ? AND state = 'prepared'`,
    ).run(new Date().toISOString(), new Date().toISOString(), attemptId)).immediate();
    if (dispatched.changes !== 1) {
      throw new ApiError({
        statusCode: 409,
        code: "MODEL_RESULT_UNKNOWN",
        message: "模型调用未能进入已派发状态",
      });
    }
    return { attemptId, logicalCallId, requestHash: intent.requestHash, retransmit: false };
  }

  result(fence: WorkerFence, message: WorkerCallResult): { accepted: boolean; effective: boolean } {
    const row = this.db.prepare(
      "SELECT attempt_id, job_id, logical_call_id, request_hash, state, fence_attempt, fence_lease_generation, lease_owner, response_hash, request_envelope_json FROM provider_calls WHERE attempt_id = ? AND job_id = ?",
    ).get(message.attemptId, fence.jobId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "模型调用记录不存在" });
    }
    const call = CallRowSchema.parse(row);
    if (call.logical_call_id !== message.logicalCallId || call.request_hash !== message.requestHash) {
      throw new ApiError({
        statusCode: 409,
        code: "CALL_IDENTITY_CONFLICT",
        message: "模型结果与逻辑调用不匹配",
      });
    }
    const currentFence =
      call.fence_attempt === fence.attempt &&
      call.fence_lease_generation === fence.leaseGeneration &&
      call.lease_owner === fence.leaseOwner;
    if (call.state === "completed" && call.response_hash === message.responseHash) {
      return { accepted: true, effective: true };
    }
    const effective = currentFence && (call.state === "dispatched" || call.state === "prepared");
    return this.db.transaction(() => {
      const payloadExists = this.db.prepare(
        "SELECT attempt_id FROM provider_call_payloads WHERE attempt_id = ?",
      ).get(call.attempt_id);
      if (payloadExists === undefined) {
        this.db.prepare(
          `INSERT INTO provider_call_payloads(
            attempt_id, request_envelope_json, raw_response, received_at
          ) VALUES (?, ?, ?, ?)`,
        ).run(call.attempt_id, call.request_envelope_json, message.rawResponse, new Date().toISOString());
      } else if (call.response_hash !== null && call.response_hash !== message.responseHash) {
        this.db.prepare(
          `INSERT INTO provider_late_responses(
            id, attempt_id, response_hash, raw_response, provider_request_id, cost_json,
            effective, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          randomUUID(),
          call.attempt_id,
          message.responseHash,
          message.rawResponse,
          message.providerRequestId,
          message.cost === null ? null : JSON.stringify(message.cost),
          new Date().toISOString(),
        );
        return { accepted: true, effective: false };
      }
      if (!effective) {
        this.db.prepare(
          `INSERT INTO provider_late_responses(
            id, attempt_id, response_hash, raw_response, provider_request_id, cost_json,
            effective, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        ).run(
          randomUUID(),
          call.attempt_id,
          message.responseHash,
          message.rawResponse,
          message.providerRequestId,
          message.cost === null ? null : JSON.stringify(message.cost),
          new Date().toISOString(),
        );
        return { accepted: true, effective: false };
      }
      this.db.prepare(
        `UPDATE provider_calls
         SET state = 'completed', response_hash = ?, provider_request_id = ?,
             cost_json = ?, completed_at = ?, updated_at = ?
         WHERE attempt_id = ? AND state IN ('prepared', 'dispatched')`,
      ).run(
        message.responseHash,
        message.providerRequestId,
        message.cost === null ? null : JSON.stringify(message.cost),
        new Date().toISOString(),
        new Date().toISOString(),
        call.attempt_id,
      );
      return { accepted: true, effective: true };
    }).immediate();
  }

  cancelJob(jobId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE provider_calls SET state = 'cancelled', updated_at = ?
       WHERE job_id = ? AND state IN ('prepared', 'dispatched')`,
    ).run(now, jobId);
  }

  classifyRecovery(jobId: string): "local" | "prepared" | "waiting_input" | "completed" {
    const rows = z.array(z.object({ state: z.string() })).parse(
      this.db.prepare("SELECT state FROM provider_calls WHERE job_id = ? ORDER BY prepared_at").all(jobId),
    );
    if (rows.length === 0) return "local";
    if (rows.some((row) => row.state === "dispatched" || row.state === "unknown")) return "waiting_input";
    if (rows.some((row) => row.state === "completed")) return "completed";
    return "prepared";
  }

  private currentJob(fence: WorkerFence): z.infer<typeof JobRowSchema> {
    const row = this.db.prepare(
      `SELECT input_hash, input_json, state, attempt, lease_generation, lease_owner, cancel_requested
       FROM jobs WHERE id = ?`,
    ).get(fence.jobId);
    if (row === undefined) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "任务不存在" });
    }
    const job = JobRowSchema.parse(row);
    if (
      job.state !== "running" ||
      job.attempt !== fence.attempt ||
      job.lease_generation !== fence.leaseGeneration ||
      job.lease_owner !== fence.leaseOwner ||
      job.cancel_requested === 1
    ) {
      throw new ApiError({
        statusCode: 409,
        code: "JOB_STALE_LEASE",
        message: "任务租约已变化，禁止派发模型调用",
      });
    }
    return job;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
