import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  JobCheckpointSchema,
  WorkerFinishedSchema,
  JobErrorSchema,
  JobEventPayloadSchema,
  JobEventSchema,
  JobIdSchema,
  JobInputSchema,
  JobResultSchema,
  JobSnapshotSchema,
  JobStateSchema,
  JobTypeSchema,
  UtcTimeSchema,
  type ErrorCode,
  type JobCheckpoint,
  type JobEvent,
  type JobEventKind,
  type JobEventPayload,
  type JobInput,
  type JobResult,
  type JobSnapshot,
  type JobType,
  type WorkerFence,
} from "@dmall/contracts";
import { ApiError } from "./errors.js";

const JobRowSchema = z.strictObject({
  id: z.uuid(),
  type: JobTypeSchema,
  input_hash: z.string(),
  input_json: z.string(),
  idempotency_key: z.string().nullable(),
  business_key: z.string().nullable(),
  state: JobStateSchema,
  phase: z.string(),
  attempt: z.int().nonnegative(),
  max_attempts: z.int().positive(),
  checkpoint_json: z.string().nullable(),
  result_json: z.string().nullable(),
  error_json: z.string().nullable(),
  lease_owner: z.string().nullable(),
  lease_generation: z.int().nonnegative(),
  lease_until: UtcTimeSchema.nullable(),
  next_run_at: UtcTimeSchema.nullable(),
  cancel_requested: z.int().min(0).max(1),
  recovery_policy: z.enum(["local", "provider_fenced"]),
  created_at: UtcTimeSchema,
  updated_at: UtcTimeSchema,
});

const EventRowSchema = z.strictObject({
  job_id: z.uuid(),
  seq: z.int().positive(),
  kind: z.enum(["progress", "item_result", "warning", "needs_input", "completed", "error"]),
  phase: z.string(),
  done: z.int().nonnegative().nullable(),
  total: z.int().nonnegative().nullable(),
  payload_json: z.string(),
  created_at: UtcTimeSchema,
});

export interface JobRow {
  snapshot: JobSnapshot;
  inputHash: string;
  input: JobInput;
  leaseOwner: string | null;
}

export class JobRepository {
  private readonly localFinalizers: Array<(id: string, state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled", result: JobResult | null) => {state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null}> = [];
  private readonly waitingObservers: Array<(id: string) => void> = [];
  addLocalFinalizer(finalizer: (id: string, state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled", result: JobResult | null) => {state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null}): void {
    this.localFinalizers.push(finalizer);
  }
  addWaitingObserver(observer: (id: string) => void): void {
    this.waitingObservers.push(observer);
  }

  private readonly db: Database.Database;
  private recoveryClassifier: ((id: string) => "local" | "prepared" | "waiting_input" | "completed") | null = null;

  constructor(db: Database.Database) {
    this.db = db;
  }

  setRecoveryClassifier(classifier: (id: string) => "local" | "prepared" | "waiting_input" | "completed"): void {
    this.recoveryClassifier = classifier;
  }

  create(input: {
    id?: string;
    type: JobType;
    input: JobInput;
    inputHash: string;
    idempotencyKey: string | null;
    businessKey?: string;
  }): JobSnapshot {
    if (input.businessKey !== undefined) {
      const existing = this.findBusinessKey(input.businessKey);
      if (existing !== null) {
        if (existing.inputHash !== input.inputHash || existing.snapshot.type !== input.type || (input.id !== undefined && existing.snapshot.id !== input.id)) {
          throw new ApiError({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT", message: "任务业务身份对应不同输入" });
        }
        return existing.snapshot;
      }
    }
    JobInputSchema.parse(input.input);
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const recoveryPolicy =
      input.type === "authoring_provider" || input.type === "authoring_transcription"
        || input.type === "authoring_probe" || input.type === "composition_provider"
        ? "provider_fenced"
        : "local";
    this.db
      .prepare(
        `INSERT INTO jobs
          (id, type, input_hash, input_json, idempotency_key, state, phase, attempt, max_attempts,
           checkpoint_json, result_json, error_json, lease_owner, lease_generation, lease_until,
           next_run_at, cancel_requested, created_at, updated_at, recovery_policy, business_key)
         VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.inputHash,
        JSON.stringify(input.input),
        input.idempotencyKey,
        recoveryPolicy === "provider_fenced" ? 2 : 3,
        now,
        now,
        recoveryPolicy,
        input.businessKey ?? null,
      );
    this.addEventInternal({
      jobId: id,
      kind: "progress",
      phase: "queued",
      done: 0,
      total: null,
      payload: { kind: "progress", message: "任务已排队" },
    });
    return this.snapshotById(id);
  }

  saveOutputCompletion(message: z.infer<typeof WorkerFinishedSchema>): void {
    if (message.result?.jobType !== "export_output" || !this.isFenceValid(message.fence)) return;
    const row = this.get(message.fence.jobId);
    if (row === null || row.input.jobType !== "export_output" || row.input.exportId !== message.result.exportId) {
      throw new ApiError({ statusCode: 409, code: "DELIVERY_IDENTITY_CONFLICT", message: "输出完成消息不属于原任务" });
    }
    const key = `output:completion:${message.fence.attempt}:${message.fence.leaseGeneration}`;
    this.db.prepare("INSERT INTO worker_receipts(job_id, receipt_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, receipt_key) DO NOTHING")
      .run(message.fence.jobId, key, row.inputHash, JSON.stringify(message), new Date().toISOString());
  }

  pendingOutputCompletions(limit: number): z.infer<typeof WorkerFinishedSchema>[] {
    const rows = z.array(z.object({ result_json: z.string() })).parse(this.db.prepare(`SELECT r.result_json FROM worker_receipts r JOIN jobs j ON j.id = r.job_id
      WHERE j.type = 'export_output' AND j.state = 'queued' AND j.cancel_requested = 0 AND r.input_hash = j.input_hash
        AND r.receipt_key = 'output:completion:' || j.attempt || ':' || j.lease_generation
      ORDER BY j.updated_at LIMIT ?`).all(limit));
    return rows.map((row) => WorkerFinishedSchema.parse(JSON.parse(row.result_json)));
  }

  finishRecoveredOutput(message: z.infer<typeof WorkerFinishedSchema>, preparationError?: string): JobEvent | null {
    return this.db.transaction(() => {
      const row = this.get(message.fence.jobId);
      if (row === null || row.snapshot.state !== "queued" || row.snapshot.cancelRequested || row.snapshot.attempt !== message.fence.attempt || row.snapshot.leaseGeneration !== message.fence.leaseGeneration) return null;
      if (message.result?.jobType !== "export_output" || (message.state !== "succeeded" && message.state !== "partial")) return null;
      const final = this.applyLocalFinalizers(message.fence.jobId, preparationError === undefined ? message.state : "failed", message.result);
      const error = preparationError === undefined ? message.error : { code: "INTERNAL_ERROR", message: preparationError, retryable: true };
      this.db.prepare("UPDATE jobs SET state = ?, phase = 'done', result_json = ?, error_json = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
        .run(final.state, JSON.stringify(final.result), error === null ? null : JSON.stringify(error), new Date().toISOString(), message.fence.jobId);
      return this.addEventInternal({ jobId: message.fence.jobId, kind: final.state === "failed" ? "error" : "completed", phase: "done", done: null, total: null,
        payload: final.state === "failed" ? { kind: "error", code: "INTERNAL_ERROR", message: preparationError ?? "输出登记失败", retryable: true }
          : { kind: "completed", state: final.state === "succeeded" ? "succeeded" : "partial", message: "已核对原输出文件并恢复登记" } });
    })();
  }

  findBusinessKey(key: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE business_key = ?").get(key);
    return row === undefined ? null : this.parseRow(row);
  }

  completeRecovered(id: string, result: JobResult): JobEvent | null {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row === null || row.input.jobType !== "composition_provider" || row.snapshot.cancelRequested || row.snapshot.state === "cancelled" || row.snapshot.state === "succeeded") return null;
      if (row.snapshot.state === "running") return null;
      const parsed = JobResultSchema.parse(result);
      this.db.prepare("UPDATE jobs SET state = 'succeeded', phase = 'done', result_json = ?, error_json = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(parsed), new Date().toISOString(), id);
      return this.addEventInternal({ jobId: id, kind: "completed", phase: "done", done: null, total: null, payload: { kind: "completed", state: "succeeded", message: "已恢复保存的模型响应" } });
    })();
  }

  get(id: string): JobRow | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    if (row === undefined) return null;
    return this.parseRow(row);
  }

  snapshotById(id: string): JobSnapshot {
    const row = this.get(id);
    if (row === null) {
      throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "任务不存在" });
    }
    return row.snapshot;
  }

  recoverInterrupted(): JobEvent[] {
    const ids = z.array(z.object({ id: z.uuid() })).parse(
      this.db.prepare("SELECT id FROM jobs WHERE state = 'running' OR (state = 'queued' AND (cancel_requested = 1 OR attempt >= max_attempts))").all(),
    );
    return ids.flatMap(({ id }) => {
      const event = this.requeueAfterWorkerExit(id);
      return event === null ? [] : [event];
    });
  }

  expiredRunning(): JobSnapshot[] {
    return z.array(z.object({ id: z.uuid() })).parse(
      this.db.prepare("SELECT id FROM jobs WHERE state = 'running' AND lease_until <= ?").all(new Date().toISOString()),
    ).map(({ id }) => this.snapshotById(id));
  }

  settleQueued(): JobEvent[] {
    const ids = z.array(z.object({ id: z.uuid() })).parse(
      this.db.prepare("SELECT id FROM jobs WHERE state = 'queued' AND (cancel_requested = 1 OR attempt >= max_attempts)").all(),
    );
    return ids.flatMap(({ id }) => {
      const event = this.requeueAfterWorkerExit(id);
      return event === null ? [] : [event];
    });
  }

  requeueAfterWorkerExit(id: string): JobEvent | null {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row === null || (row.snapshot.state !== "running" && row.snapshot.state !== "queued")) return null;
      const snapshot = row.snapshot;
      if (snapshot.state === "queued" && !snapshot.cancelRequested && snapshot.attempt < snapshot.maxAttempts) return null;
      const policy = z.strictObject({ recovery_policy: z.enum(["local", "provider_fenced"]) }).parse(
        this.db.prepare("SELECT recovery_policy FROM jobs WHERE id = ?").get(id),
      ).recovery_policy;
      if (snapshot.state === "running" && policy === "provider_fenced" && this.recoveryClassifier !== null) {
        const classification = this.recoveryClassifier(id);
        if (classification === "waiting_input" || classification === "completed") {
          const now = new Date().toISOString();
          const error = {
            code: "MODEL_RESULT_UNKNOWN" as const,
            message: classification === "completed"
              ? "模型响应已保存，但任务在完成回执前中断，请人工恢复"
              : "模型请求可能已发送，结果未知；不会自动重发",
            retryable: false,
          };
          this.db.prepare(
            `UPDATE jobs SET state = 'waiting_input', phase = 'provider_recovery',
             lease_owner = NULL, lease_until = NULL, error_json = ?, updated_at = ? WHERE id = ?`,
          ).run(JSON.stringify(error), now, id);
          return this.addEventInternal({
            jobId: id,
            kind: "needs_input",
            phase: "provider_recovery",
            done: null,
            total: null,
            payload: { kind: "needs_input", reason: "MODEL_RESULT_UNKNOWN", message: error.message },
          });
        }
      }
      if (row.input.jobType === "export_output" && !snapshot.cancelRequested && this.db.prepare("SELECT 1 FROM worker_receipts WHERE job_id = ? AND receipt_key = ? AND input_hash = ?").get(id, `output:completion:${snapshot.attempt}:${snapshot.leaseGeneration}`, row.inputHash) !== undefined) {
        this.db.prepare("UPDATE jobs SET state = 'queued', phase = 'output_recovery', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
        return null;
      }
      const requestedState = snapshot.cancelRequested ? "cancelled" : snapshot.attempt >= snapshot.maxAttempts ? "failed" : "queued";
      const finalized = this.applyLocalFinalizers(id, requestedState, snapshot.result);
      const {state, result} = finalized;
      const error = state === "failed" ? { code: "INTERNAL_ERROR", message: "任务已达到最大重试次数", retryable: false } satisfies NonNullable<JobSnapshot["error"]> : null;
      this.db.prepare(`UPDATE jobs SET state = ?, phase = ?, lease_owner = NULL, lease_until = NULL,
        result_json = ?, error_json = ?, updated_at = ? WHERE id = ?`).run(state, state === "queued" ? "recovered" : "done", result === null ? null : JSON.stringify(result), error === null ? null : JSON.stringify(error), new Date().toISOString(), id);
      const payload: JobEventPayload = state === "cancelled" || state === "partial" || state === "succeeded"
        ? { kind: "completed", state, message: state === "cancelled" ? "任务已取消" : "任务部分完成" }
        : error !== null ? { kind: "error", ...error }
        : { kind: "progress", message: "任务恢复排队" };
      return this.addEventInternal({ jobId: id, kind: payload.kind, phase: state === "queued" ? "recovered" : "done", done: null, total: null, payload });
    })();
  }

  nextQueued(limit: number): JobRow[] {
    const now = new Date().toISOString();
    const ids = z
      .array(z.strictObject({ id: z.uuid() }))
      .parse(
        this.db
          .prepare(
            `SELECT id FROM jobs
             WHERE state = 'queued' AND cancel_requested = 0
               AND (next_run_at IS NULL OR next_run_at <= ?)
             ORDER BY created_at ASC, id ASC LIMIT ?`,
          )
          .all(now, limit),
      );
    return ids.flatMap(({ id }) => {
      const row = this.get(id);
      return row === null ? [] : [row];
    });
  }

  countRunningType(type: JobType): number {
    return z
      .strictObject({ count: z.int().nonnegative() })
      .parse(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM jobs WHERE state = 'running' AND type = ?")
          .get(type),
      ).count;
  }

  prepareRetry(id: string): JobSnapshot {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row === null) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "任务不存在" });
      }
      if (row.snapshot.state === "running" || row.snapshot.cancelRequested) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "任务正在执行或已取消，不能重试",
        });
      }
      if (row.input.jobType === "composition_provider" || row.input.jobType === "feishu_publish" ||
          (row.input.jobType === "export_output" && this.db.prepare("SELECT id FROM exports WHERE id = ? AND business_key IS NOT NULL").get(row.input.exportId) !== undefined)) {
        throw new ApiError({ statusCode: 409, code: "JOB_NOT_RESUMABLE", message: "该任务必须通过原创作交付决策恢复" });
      }
      const policy = z.strictObject({ recovery_policy: z.enum(["local", "provider_fenced"]) }).parse(
        this.db.prepare("SELECT recovery_policy FROM jobs WHERE id = ?").get(id),
      ).recovery_policy;
      this.db
        .prepare(
          `UPDATE jobs SET state = 'queued', phase = 'retry', cancel_requested = 0,
             max_attempts = CASE WHEN attempt >= max_attempts THEN attempt + 1 ELSE max_attempts END,
             lease_owner = NULL, lease_until = NULL, result_json = NULL, error_json = NULL,
             checkpoint_json = CASE WHEN ? = 'provider_fenced' THEN checkpoint_json ELSE NULL END,
             updated_at = ? WHERE id = ?`,
        )
        .run(policy, new Date().toISOString(), id);
      this.addEventInternal({
        jobId: id,
        kind: "progress",
        phase: "retry",
        done: null,
        total: null,
        payload: { kind: "progress", message: "任务已准备重试" },
      });
      return this.snapshotById(id);
    })();
  }

  resumeOutput(id: string): JobSnapshot {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row === null) throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "输出任务不存在" });
      if ((row.input.jobType !== "feishu_publish" && row.input.jobType !== "export_output") ||
          !["failed", "partial"].includes(row.snapshot.state) || row.snapshot.cancelRequested) {
        throw new ApiError({ statusCode: 409, code: "JOB_NOT_RESUMABLE", message: "只有失败或部分完成的原输出任务可以恢复" });
      }
      this.db.prepare(`UPDATE jobs SET state = 'queued', phase = 'resumed',
        max_attempts = CASE WHEN attempt >= max_attempts THEN attempt + 1 ELSE max_attempts END,
        lease_owner = NULL, lease_until = NULL, error_json = NULL, result_json = NULL, updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), id);
      this.addEventInternal({ jobId: id, kind: "progress", phase: "resumed", done: null, total: null, payload: { kind: "progress", message: "保留原输出进度继续交付" } });
      return this.snapshotById(id);
    })();
  }

  explicitProviderRetry(id: string, expectedInputHash: string): JobSnapshot {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row === null) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "任务不存在" });
      }
      const policy = z.strictObject({ recovery_policy: z.enum(["local", "provider_fenced"]) }).parse(
        this.db.prepare("SELECT recovery_policy FROM jobs WHERE id = ?").get(id),
      ).recovery_policy;
      if (row.input.jobType === "composition_provider" || policy !== "provider_fenced" || row.snapshot.state !== "waiting_input") {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "只有结果未知的模型任务可以创建明确的新尝试",
        });
      }
      if (row.inputHash !== expectedInputHash) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "任务固定输入已变化，必须创建新的生成输入",
        });
      }
      return this.prepareRetry(id);
    })();
  }

  assign(id: string, leaseOwner: string): {
    grant: {
      schemaVersion: 1;
      jobId: string;
      fence: WorkerFence;
      inputHash: string;
      input: JobInput;
      checkpoint: JobCheckpoint | null;
    };
  } {
    const transaction = this.db.transaction(() => {
      const row = this.get(id);
      if (row === null) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "任务不存在" });
      }
      if (row.snapshot.state !== "queued" || row.snapshot.cancelRequested) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "任务当前不能启动",
        });
      }
      const attempt = row.snapshot.attempt + 1;
      if (attempt > row.snapshot.maxAttempts) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "任务已达到最大重试次数",
        });
      }
      const generation = row.snapshot.leaseGeneration + 1;
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + 30_000).toISOString();
      this.db
        .prepare(
          `UPDATE jobs SET state = 'running', phase = 'starting', attempt = ?, lease_owner = ?,
             lease_generation = ?, lease_until = ?, updated_at = ? WHERE id = ?`,
        )
        .run(attempt, leaseOwner, generation, leaseUntil, now.toISOString(), id);
      const fence: WorkerFence = {
        jobId: JobIdSchema.parse(id),
        attempt,
        leaseOwner,
        leaseGeneration: generation,
      };
      return {
        grant: {
          schemaVersion: 1 as const,
          jobId: id,
          fence,
          inputHash: row.inputHash,
          input: row.input,
          checkpoint: row.snapshot.checkpoint,
        },
      };
    });
    return transaction();
  }

  heartbeat(fence: WorkerFence): boolean {
    const row = this.get(fence.jobId);
    if (!this.isFenceCurrent(row, fence)) return false;
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    this.db
      .prepare("UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ?")
      .run(leaseUntil, new Date().toISOString(), fence.jobId);
    return true;
  }

  checkpoint(fence: WorkerFence, checkpoint: JobCheckpoint): boolean {
    const row = this.get(fence.jobId);
    if (!this.isFenceCurrent(row, fence) || row === null) return false;
    if (checkpoint.jobType !== row.input.jobType) return false;
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET checkpoint_json = ?, phase = 'checkpoint', lease_until = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(checkpoint), leaseUntil, now, fence.jobId);
    return true;
  }

  waitForInput(fence: WorkerFence, checkpoint: JobCheckpoint, reason: string, message: string): JobEvent | null {
    return this.db.transaction(() => {
      const row = this.get(fence.jobId);
      if (!this.isFenceCurrent(row, fence) || row === null) return null;
      if (checkpoint.jobType !== row.input.jobType) return null;
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE jobs SET state = 'waiting_input', phase = 'waiting_input', checkpoint_json = ?,
           lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(checkpoint), now, fence.jobId);
      const event = this.addEventInternal({
        jobId: fence.jobId,
        kind: "needs_input",
        phase: "waiting_input",
        done: null,
        total: null,
        payload: { kind: "needs_input", reason, message },
      });
      for (const observer of this.waitingObservers) observer(fence.jobId);
      return event;
    })();
  }

  event(input: {
    fence: WorkerFence;
    kind: JobEventKind;
    phase: string;
    done: number | null;
    total: number | null;
    payload: JobEventPayload;
  }): JobEvent | null {
    const row = this.get(input.fence.jobId);
    if (!this.isFenceCurrent(row, input.fence)) return null;
    if (input.kind !== input.payload.kind) {
      return null;
    }
    return this.addEventInternal({
      jobId: input.fence.jobId,
      kind: input.kind,
      phase: input.phase,
      done: input.done,
      total: input.total,
      payload: input.payload,
    });
  }

  finish(input: {
    fence: WorkerFence;
    state: "succeeded" | "partial" | "failed" | "cancelled" | "waiting_input";
    result: JobResult | null;
    error: { code: ErrorCode; message: string; retryable: boolean } | null;
    finalize?: (state: "succeeded" | "partial" | "failed" | "cancelled" | "waiting_input") => JobResult | null;
  }): JobEvent | null {
    return this.db.transaction(() => {
      const row = this.get(input.fence.jobId);
      if (!this.isFenceCurrent(row, input.fence, true)) return null;
      if (input.state === "succeeded" && input.result === null) return null;
      if (input.state === "failed" && input.error === null) return null;
      const requestedState = row?.snapshot.cancelRequested === true ? "cancelled" : input.state;
      const initialResult = input.finalize === undefined ? input.result : input.finalize(requestedState);
      const finalized = requestedState === "waiting_input"
        ? { state: requestedState, result: initialResult }
        : this.applyLocalFinalizers(input.fence.jobId, requestedState, initialResult);
      if (finalized.state === "queued") throw new Error("终态不能重新排队");
      const {state, result} = finalized;
      const error = state === "failed" || state === "waiting_input"
        ? input.error ?? {code: state === "waiting_input" ? "MODEL_RESULT_UNKNOWN" : "INTERNAL_ERROR", message: state === "waiting_input" ? "任务需要人工决定" : "没有可用的导入结果", retryable:false} satisfies NonNullable<JobSnapshot["error"]>
        : null;
      if ((state === "succeeded" || state === "partial") && result === null) return null;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE jobs SET state = ?, phase = ?, result_json = ?, error_json = ?,
             lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(
          state,
          "done",
          result === null ? null : JSON.stringify(JobResultSchema.parse(result)),
          error === null ? null : JSON.stringify(error),
          now,
          input.fence.jobId,
        );
      const payload: JobEventPayload =
        state === "waiting_input"
          ? {
              kind: "needs_input",
              reason: error?.code ?? "MODEL_RESULT_UNKNOWN",
              message: error?.message ?? "任务需要人工决定",
            }
          : state === "failed"
          ? {
              kind: "error",
              code: error?.code ?? "INTERNAL_ERROR",
              message: error?.message ?? "任务失败",
              retryable: error?.retryable ?? false,
            }
          : {
              kind: "completed",
              state,
              message: state === "succeeded" ? "任务完成" : state === "partial" ? "任务部分完成" : "任务已取消",
            };
      return this.addEventInternal({
        jobId: input.fence.jobId,
        kind: payload.kind,
        phase: "done",
        done: null,
        total: null,
        payload,
      });
    })();
  }

  requestCancel(
    id: string,
    generation: number,
    saveResult?: (snapshot: JobSnapshot) => void,
  ): {
    snapshot: JobSnapshot;
    shouldSignalWorker: boolean;
    event: JobEvent | null;
  } {
    const transaction = this.db.transaction(() => {
      const row = this.get(id);
      if (row === null) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "任务不存在" });
      }
      if (row.snapshot.state === "running" && row.snapshot.leaseGeneration !== generation) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_STALE_LEASE",
          message: "任务执行代次已变化",
        });
      }
      if (["succeeded", "failed", "cancelled"].includes(row.snapshot.state)) {
        saveResult?.(row.snapshot);
        return { snapshot: row.snapshot, shouldSignalWorker: false, event: null };
      }
      const now = new Date().toISOString();
      if (row.snapshot.state === "queued" || row.snapshot.state === "waiting_input") {
        const finalized = this.applyLocalFinalizers(id, "cancelled", row.snapshot.result);
        this.db.prepare("UPDATE jobs SET result_json = ? WHERE id = ?").run(finalized?.result == null ? null : JSON.stringify(finalized.result), id);
        this.db
          .prepare("UPDATE jobs SET cancel_requested = 1, state = 'cancelled', phase = 'done', updated_at = ? WHERE id = ?")
          .run(now, id);
        const event = this.addEventInternal({
          jobId: id,
          kind: "completed",
          phase: "done",
          done: null,
          total: null,
          payload: { kind: "completed", state: "cancelled", message: "任务已取消" },
        });
        const snapshot = this.snapshotById(id);
        saveResult?.(snapshot);
        return { snapshot, shouldSignalWorker: false, event };
      }
      this.db
        .prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
        .run(now, id);
      const snapshot = this.snapshotById(id);
      saveResult?.(snapshot);
      return { snapshot, shouldSignalWorker: true, event: null };
    });
    return transaction();
  }

  resume(id: string, saveResult?: (snapshot: JobSnapshot) => void): { snapshot: JobSnapshot; event: JobEvent } {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row === null) {
        throw new ApiError({ statusCode: 404, code: "NOT_FOUND", message: "任务不存在" });
      }
      if (row.snapshot.state !== "waiting_input" || row.snapshot.cancelRequested) {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "只有等待人工输入的任务可以恢复",
        });
      }
      const policy = z.strictObject({ recovery_policy: z.enum(["local", "provider_fenced"]) }).parse(
        this.db.prepare("SELECT recovery_policy FROM jobs WHERE id = ?").get(id),
      ).recovery_policy;
      if (policy === "provider_fenced") {
        throw new ApiError({
          statusCode: 409,
          code: "JOB_NOT_RESUMABLE",
          message: "模型任务结果未知时必须由用户选择明确的新尝试、取消或补输入；通用恢复入口不会自动重发",
        });
      }
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE jobs SET state = 'queued', phase = 'resumed', max_attempts = CASE WHEN attempt >= max_attempts THEN attempt + 1 ELSE max_attempts END, updated_at = ? WHERE id = ?")
        .run(now, id);
      const event = this.addEventInternal({
        jobId: id,
        kind: "progress",
        phase: "resumed",
        done: null,
        total: null,
        payload: { kind: "progress", message: "任务恢复排队" },
      });
      const snapshot = this.snapshotById(id);
      saveResult?.(snapshot);
      return { snapshot, event };
    })();
  }

  events(jobId: string, afterSeq: number): JobEvent[] {
    const rows = z.array(EventRowSchema).parse(
      this.db
        .prepare(
          `SELECT job_id, seq, kind, phase, done, total, payload_json, created_at
           FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq ASC`,
        )
        .all(jobId, afterSeq),
    );
    return rows.map((row) =>
      JobEventSchema.parse({
        schemaVersion: 1,
        seq: row.seq,
        jobId: row.job_id,
        kind: row.kind,
        phase: row.phase,
        done: row.done,
        total: row.total,
        payload: JSON.parse(row.payload_json) as unknown,
        at: row.created_at,
      }),
    );
  }

  isFenceValid(fence: WorkerFence, allowCancel = false): boolean {
    return this.isFenceCurrent(this.get(fence.jobId), fence, allowCancel);
  }

  appendEventInTransaction(input: {
    jobId: string;
    kind: JobEventKind;
    phase: string;
    done: number | null;
    total: number | null;
    payload: JobEventPayload;
  }): JobEvent {
    return this.addEventInternal(input);
  }

  private parseRow(raw: unknown): JobRow {
    const row = JobRowSchema.parse(raw);
    const checkpoint =
      row.checkpoint_json === null ? null : JobCheckpointSchema.parse(JSON.parse(row.checkpoint_json));
    const result =
      row.result_json === null ? null : JobResultSchema.parse(JSON.parse(row.result_json));
    const error = row.error_json === null ? null : JobErrorSchema.parse(JSON.parse(row.error_json));
    const snapshot = JobSnapshotSchema.parse({
      schemaVersion: 1,
      id: row.id,
      type: row.type,
      state: row.state,
      phase: row.phase,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      leaseGeneration: row.lease_generation,
      leaseUntil: row.lease_until,
      cancelRequested: row.cancel_requested === 1,
      checkpoint,
      result,
      error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return {
      snapshot,
      inputHash: row.input_hash,
      input: JobInputSchema.parse(JSON.parse(row.input_json)),
      leaseOwner: row.lease_owner,
    };
  }

  private isFenceCurrent(row: JobRow | null, fence: WorkerFence, allowCancel = false): boolean {
    return (
      row !== null &&
      row.snapshot.state === "running" &&
      row.snapshot.attempt === fence.attempt &&
      row.snapshot.leaseGeneration === fence.leaseGeneration &&
      row.leaseOwner === fence.leaseOwner &&
      row.snapshot.leaseUntil !== null &&
      Date.parse(row.snapshot.leaseUntil) > Date.now() &&
      (allowCancel || !row.snapshot.cancelRequested)
    );
  }

  private applyLocalFinalizers(
    id: string,
    state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled",
    result: JobResult | null,
  ): {state: "queued" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled"; result: JobResult | null} {
    let current = { state, result };
    for (const finalizer of this.localFinalizers) {
      current = finalizer(id, current.state, current.result);
    }
    return current;
  }

  private addEventInternal(input: {
    jobId: string;
    kind: JobEventKind;
    phase: string;
    done: number | null;
    total: number | null;
    payload: JobEventPayload;
  }): JobEvent {
    const eventPayload = JobEventPayloadSchema.parse(input.payload);
    const now = new Date().toISOString();
    const next = z
      .strictObject({ seq: z.int().positive() })
      .parse(
        this.db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_events WHERE job_id = ?")
          .get(input.jobId),
      );
    this.db
      .prepare(
        `INSERT INTO job_events(job_id, seq, kind, phase, done, total, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        next.seq,
        input.kind,
        input.phase,
        input.done,
        input.total,
        JSON.stringify(eventPayload),
        now,
      );
    return JobEventSchema.parse({
      schemaVersion: 1,
      seq: next.seq,
      jobId: input.jobId,
      kind: input.kind,
      phase: input.phase,
      done: input.done,
      total: input.total,
      payload: eventPayload,
      at: now,
    });
  }
}
