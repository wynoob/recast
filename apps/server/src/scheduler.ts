import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  JobGrantSchema,
  type ErrorCode,
  type JobEvent,
  type JobGrant,
  type JobResult,
  type JobSnapshot,
  type WorkerToHostMessage,
} from "@dmall/contracts";
import type { JobRepository } from "./job-repository.js";
import type { WorkerPool } from "./worker-pool.js";
import type { JobEventBus } from "./event-bus.js";
import type { ImportService } from "./import-service.js";
import type { RemoteOperationRepository } from "./remote-operations.js";
import type { ProviderJournal } from "./authoring/provider-journal.js";

export class JobScheduler {
  private readonly jobs: JobRepository;
  private readonly pool: WorkerPool;
  private readonly events: JobEventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly imports: ImportService | null;
  private readonly remoteOps: RemoteOperationRepository | null;
  private readonly prepareOutputGrant: ((grant: JobGrant) => Promise<JobGrant>) | null;
  private readonly providerJournal: ProviderJournal | null;
  private readonly prepareCompletion: ((jobId: string, result: JobResult | null) => Promise<void>) | null;
  private readonly advanceCompositions: (() => Promise<void>) | null;
  private timer: NodeJS.Timeout | null = null;
  private maintenance: Promise<void> | null = null;
  private closing = false;
  private lastCompositionSweep = 0;
  private compositionChanged = true;

  constructor(input: {
    jobs: JobRepository;
    pool: WorkerPool;
    events: JobEventBus;
    logger: FastifyBaseLogger;
    imports?: ImportService;
    remoteOps?: RemoteOperationRepository;
    prepareOutputGrant?: (grant: JobGrant) => Promise<JobGrant>;
    providerJournal?: ProviderJournal;
    prepareCompletion?: (jobId: string, result: JobResult | null) => Promise<void>;
    advanceCompositions?: () => Promise<void>;
  }) {
    this.prepareCompletion = input.prepareCompletion ?? null;
    this.advanceCompositions = input.advanceCompositions ?? null;
    this.jobs = input.jobs;
    this.pool = input.pool;
    this.events = input.events;
    this.logger = input.logger;
    this.imports = input.imports ?? null;
    this.remoteOps = input.remoteOps ?? null;
    this.prepareOutputGrant = input.prepareOutputGrant ?? null;
    this.providerJournal = input.providerJournal ?? null;
  }

  async start(): Promise<void> {
    for (const event of this.jobs.recoverInterrupted()) this.publish(event);
    this.pool.setMessageHandler((message) => this.handleWorkerMessage(message));
    this.pool.setWorkerExitHandler((jobId) => {
      this.compositionChanged = true;
      const event = this.jobs.requeueAfterWorkerExit(jobId);
      if (event !== null) this.publish(event);
      this.kick();
    });
    await this.pool.start();
    this.timer = setInterval(() => this.kick(), 200);
    this.timer.unref();
    this.kick();
  }

  kick(): void {
    if (this.closing || this.maintenance !== null) return;
    this.maintenance = this.tick().catch((error: unknown) => {
      this.logger.error({ err: error }, "scheduler maintenance failed");
    }).finally(() => {
      this.maintenance = null;
    });
  }

  async cancel(snapshot: JobSnapshot): Promise<void> {
    this.requestCancel(snapshot);
  }

  requestCancel(snapshot: JobSnapshot, saveResult?: (current: JobSnapshot) => void): JobSnapshot {
    this.providerJournal?.cancelJob(snapshot.id);
    const result = this.jobs.requestCancel(snapshot.id, snapshot.leaseGeneration, saveResult);
    if (result.event !== null) this.publish(result.event);
    if (result.shouldSignalWorker) {
      this.pool.cancel(snapshot.id, snapshot.leaseGeneration);
    }
    this.kick();
    return result.snapshot;
  }

  resume(id: string, saveResult?: (current: JobSnapshot) => void): JobSnapshot {
    const result = this.jobs.resume(id, saveResult);
    this.publish(result.event);
    this.kick();
    return result.snapshot;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.maintenance;
    await this.pool.close();
  }

  private async tick(): Promise<void> {
    for (const snapshot of this.jobs.expiredRunning()) {
      if (this.closing) return;
      await this.pool.terminate(snapshot.id);
      const event = this.jobs.requeueAfterWorkerExit(snapshot.id);
      if (event !== null) this.publish(event);
    }
    for (const completion of this.jobs.pendingOutputCompletions(10)) {
      let preparationError: string | undefined;
      try { await this.prepareCompletion?.(completion.fence.jobId, completion.result); }
      catch (error) { preparationError = error instanceof Error ? error.message : "输出文件恢复核验失败"; }
      const event = this.jobs.finishRecoveredOutput(completion, preparationError);
      if (event !== null) this.publish(event);
    }
    for (const event of this.jobs.settleQueued()) this.publish(event);
    if (this.compositionChanged || Date.now() - this.lastCompositionSweep >= 2000) {
      this.compositionChanged = false;
      this.lastCompositionSweep = Date.now();
      await this.advanceCompositions?.();
    }
    while (!this.closing && this.pool.idleWorker()) {
      const rows = this.jobs.nextQueued(10);
      if (rows.length === 0) return;
      const importRunning = this.jobs.countRunningType("local_import") > 0;
      const row = rows.find(
        (candidate) => !(importRunning && candidate.snapshot.type === "local_import"),
      );
      if (row === undefined) return;
      try {
        const assigned = this.jobs.assign(row.snapshot.id, `api:${process.pid}:${randomUUID()}`);
        const importPreparedGrant =
          this.imports === null
            ? assigned.grant
            : await this.imports.prepareGrant(JobGrantSchema.parse(assigned.grant));
        const preparedGrant =
          this.prepareOutputGrant === null
            ? importPreparedGrant
            : await this.prepareOutputGrant(JobGrantSchema.parse(importPreparedGrant));
        const grant = JobGrantSchema.parse(preparedGrant);
        this.logger.debug({ jobId: grant.jobId, fence: grant.fence, checkpoint: grant.checkpoint }, "job granted");
        void this.pool
          .dispatch(grant)
          .catch((error: unknown) => {
            this.logger.error({ err: error, jobId: row.snapshot.id }, "worker dispatch failed");
            if (!this.closing) {
              const event = this.jobs.requeueAfterWorkerExit(row.snapshot.id);
              if (event !== null) this.publish(event);
            }
          })
          .finally(() => this.kick());
      } catch (error) {
        this.logger.error({ err: error, jobId: row.snapshot.id }, "job assignment failed");
        await this.pool.terminate(row.snapshot.id);
        const event = this.jobs.requeueAfterWorkerExit(row.snapshot.id);
        if (event !== null) this.publish(event);
        return;
      }
    }
  }

  private async handleWorkerMessage(
    message: WorkerToHostMessage,
  ): Promise<{ accepted: boolean; code: ErrorCode | null }> {
    if (message.type === "ready") return { accepted: true, code: null };
    if (message.type === "heartbeat") {
      return this.jobs.heartbeat(message.fence)
        ? { accepted: true, code: null }
        : { accepted: false, code: "JOB_STALE_LEASE" };
    }
    if (message.type === "checkpoint") {
      return this.jobs.checkpoint(message.fence, message.checkpoint)
        ? { accepted: true, code: null }
        : { accepted: false, code: "JOB_STALE_LEASE" };
    }
    if (message.type === "waiting") {
      const event = this.jobs.waitForInput(
        message.fence,
        message.checkpoint,
        message.reason,
        message.message,
      );
      if (event === null) return { accepted: false, code: "JOB_STALE_LEASE" };
      this.publish(event);
      this.kick();
      return { accepted: true, code: null };
    }
    if (message.type === "remote_operation") {
      if (this.remoteOps === null) return { accepted: false, code: "INTERNAL_ERROR" };
      if (!this.jobs.isFenceValid(message.fence, message.state === "confirmed" || message.state === "unknown")) {
        return { accepted: false, code: "JOB_STALE_LEASE" };
      }
      if (message.state === "prepare") {
        this.remoteOps.prepare({
          operationId: message.operationId,
          jobId: message.fence.jobId,
          attempt: message.fence.attempt,
          leaseGeneration: message.fence.leaseGeneration,
          kind: message.kind,
          requestHash: message.requestHash,
          remoteClientToken: message.clientToken,
        });
      } else if (message.state === "dispatched") {
        try {
          this.remoteOps.markDispatched({
            operationId: message.operationId,
            attempt: message.fence.attempt,
            leaseGeneration: message.fence.leaseGeneration,
            requestHash: message.requestHash,
          });
        } catch (error) {
          const current = this.remoteOps.get(message.operationId, message.fence.attempt, message.fence.leaseGeneration);
          if (current.state !== "dispatched") throw error;
        }
      } else if (message.state === "confirmed") {
        try {
          this.remoteOps.confirm({
            operationId: message.operationId,
            attempt: message.fence.attempt,
            leaseGeneration: message.fence.leaseGeneration,
            response: message.response ?? {},
          });
        } catch (error) {
          const current = this.remoteOps.get(message.operationId, message.fence.attempt, message.fence.leaseGeneration);
          if (current.state !== "confirmed") throw error;
        }
      } else {
        try {
          this.remoteOps.markUnknown({
            operationId: message.operationId,
            attempt: message.fence.attempt,
            leaseGeneration: message.fence.leaseGeneration,
          });
        } catch (error) {
          const current = this.remoteOps.get(message.operationId, message.fence.attempt, message.fence.leaseGeneration);
          if (current.state !== "unknown") throw error;
        }
      }
      return { accepted: true, code: null };
    }
    if (message.type === "event") {
      const event = this.jobs.event({
        fence: message.fence,
        kind: message.kind,
        phase: message.phase,
        done: message.done,
        total: message.total,
        payload: message.payload,
      });
      if (event === null) return { accepted: false, code: "JOB_STALE_LEASE" };
      this.publish(event);
      return { accepted: true, code: null };
    }
    if (message.type === "finished") {
      if (!this.jobs.isFenceValid(message.fence, true)) return { accepted: false, code: "JOB_STALE_LEASE" };
      if (message.state === "succeeded" && message.result?.jobType === "composition_provider") {
        const effective = this.providerJournal?.compositionResult(message.fence.jobId);
        if (effective === null || effective === undefined) return { accepted: false, code: "MODEL_RESULT_UNKNOWN" };
        message = { ...message, result: effective };
      }
      if (message.state === "succeeded" || message.state === "partial") {
        this.jobs.saveOutputCompletion(message);
        try { await this.prepareCompletion?.(message.fence.jobId, message.result); }
        catch (error) {
          const event = this.jobs.finish({ fence: message.fence, state: "failed", result: message.result,
            error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "输出文件准备失败", retryable: true } });
          if (event !== null) this.publish(event);
          this.kick();
          return { accepted: event !== null, code: event === null ? "JOB_STALE_LEASE" : null };
        }
      }
      if (!this.jobs.isFenceValid(message.fence, true)) return { accepted: false, code: "JOB_STALE_LEASE" };
      const event = this.jobs.finish({fence: message.fence, state: message.state, result: message.result, error: message.error});
      if (event === null) return { accepted: false, code: "JOB_STALE_LEASE" };
      this.publish(event);
      this.compositionChanged = true;
      this.kick();
      return { accepted: true, code: null };
    }
    if (message.type === "item_result") {
      if (this.imports === null) return { accepted: false, code: "INTERNAL_ERROR" };
      const event = await this.imports.acceptItemResult(message);
      if (event !== null) this.publish(event);
      return { accepted: true, code: null };
    }
    if (message.type === "call_intent") {
      if (this.providerJournal === null) return { accepted: false, code: "INTERNAL_ERROR" };
      try {
        const permit = this.providerJournal.intent(message.fence, message);
        const sent = this.pool.permit(message.fence.jobId, {
          schemaVersion: 1,
          type: "call_permit",
          messageId: randomUUID(),
          intentMessageId: message.messageId,
          attemptId: permit.attemptId,
          logicalCallId: permit.logicalCallId,
          requestHash: permit.requestHash,
          retransmit: permit.retransmit,
        });
        return sent
          ? { accepted: true, code: null }
          : { accepted: false, code: "INTERNAL_ERROR" };
      } catch (error) {
        if (error instanceof Error && "code" in error) {
          const code = String(error.code);
          return {
            accepted: false,
            code: code === "CALL_IDENTITY_CONFLICT" || code === "MODEL_RESULT_UNKNOWN" || code === "JOB_STALE_LEASE"
              ? code
              : "INTERNAL_ERROR",
          };
        }
        throw error;
      }
    }
    if (message.type === "call_result") {
      if (this.providerJournal === null) return { accepted: false, code: "INTERNAL_ERROR" };
      const result = this.providerJournal.result(message.fence, message);
      return { accepted: result.accepted && result.effective, code: result.effective ? null : "JOB_STALE_LEASE" };
    }
    const exhaustive: never = message;
    return exhaustive;
  }

  private publish(event: JobEvent): void {
    this.events.publish(event);
  }
}
