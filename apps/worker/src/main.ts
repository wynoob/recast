import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import sharp from "sharp";
import {
  HostToWorkerMessageSchema,
  type FixtureCheckpoint,
  type ImportCheckpoint,
  type ItemResultMessage,
  type JobEventPayload,
  type JobGrant,
  type JobResult,
  type ScanCheckpoint,
  type WorkerFence,
  type WorkerToHostMessage,
} from "@dmall/contracts";
import { runScanJob } from "./scan.js";
import { runImportJob } from "./local-import.js";
import { MediaProcessRuntime } from "./media-process.js";
import { WorkerTaskError } from "./task-error.js";
import { runTemplateValidation } from "./template-validation.js";
import {
  OutputWaitingError,
  RemoteResultUnknownError,
  runBundleImportJob,
  runExportOutputJob,
  runFeishuPublishJob,
  runFeishuPullJob,
  type OutputJobDeps,
} from "./outputs.js";
import {
  acceptProviderMessage,
  callAsrModel,
  callTextModel,
  callCompositionModel,
  probeTextModel,
} from "./authoring/provider-client.js";

const workerId = `${hostname()}-${process.pid}-${randomUUID()}`;
const media = new MediaProcessRuntime();
const pendingAcks = new Map<string, (value: { accepted: boolean; code: string | null }) => void>();
let active: {
  grant: JobGrant;
  cancelled: boolean;
  controller: AbortController;
  cancelWork: () => Promise<void>;
} | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let shuttingDownPromise: Promise<void> | null = null;

send({
  schemaVersion: 1,
  type: "ready",
  workerId,
  pid: process.pid,
});

process.on("message", (raw: unknown) => {
  const parsed = HostToWorkerMessageSchema.safeParse(raw);
  if (!parsed.success) {
    process.stderr.write(`worker ignored invalid host message: ${parsed.error.message}\n`);
    return;
  }
  const message = parsed.data;
  if (message.type === "grant") {
    void runGrant(message.grant);
    return;
  }
  if (message.type === "cancel") {
    if (active !== null && active.grant.jobId === message.jobId) {
      active.cancelled = true;
      active.controller.abort();
      void active.cancelWork();
    }
    return;
  }
  if (message.type === "ack") {
    acceptProviderMessage(message);
    const resolve = pendingAcks.get(message.messageId);
    if (resolve !== undefined) {
      pendingAcks.delete(message.messageId);
      resolve({ accepted: message.accepted, code: message.code });
    }
    return;
  }
  if (message.type === "call_permit") {
    acceptProviderMessage(message);
    return;
  }
  if (message.type === "shutdown") {
    void shutdown();
  }
});

process.on("disconnect", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

function send(message: WorkerToHostMessage): void {
  if (shuttingDown || typeof process.send !== "function") return;
  process.send(message);
}

async function runGrant(grant: JobGrant): Promise<void> {
  if (active !== null) {
    send({
      schemaVersion: 1,
      type: "finished",
      messageId: randomUUID(),
      fence: grant.fence,
      state: "failed",
      result: null,
      error: { code: "INTERNAL_ERROR", message: "worker 已有运行中的任务", retryable: true },
    });
    return;
  }
  const controller = new AbortController();
  const current = {
    grant,
    cancelled: false,
    controller,
    cancelWork: async (): Promise<void> => {
      await media.terminateAll();
    },
  };
  active = current;
  startHeartbeat(grant.fence);
  let exitAfterStaleLease = false;
  try {
    if (grant.input.jobType === "local_env_probe") {
      await runLocalProbe(grant);
    } else if (grant.input.jobType === "fixture_long") {
      await runFixture(grant);
    } else if (grant.input.jobType === "local_scan") {
      await runScan(grant, controller.signal);
    } else if (grant.input.jobType === "local_import") {
      await runImport(grant, controller.signal);
    } else if (grant.input.jobType === "template_validate") {
      await runTemplateValidationGrant(grant, controller.signal);
    } else if (grant.input.jobType === "export_output") {
      const result = await runExportOutputJob(grant, outputDeps(grant));
      finishSucceeded(grant.fence, result);
    } else if (grant.input.jobType === "project_bundle_import") {
      const result = await runBundleImportJob(grant);
      finishSucceeded(grant.fence, result);
    } else if (grant.input.jobType === "feishu_publish") {
      const result = await runFeishuPublishJob(grant, outputDeps(grant));
      if (result !== null) {
        if (result.warnings.some((warning) => warning.code === "FEISHU_READBACK_MISMATCH")) {
          finishPartial(grant.fence, result, {
            code: "REMOTE_RESULT_UNKNOWN",
            message: "飞书读回核对存在差异，已保留文档链接和块映射",
            retryable: false,
          });
        } else {
          finishSucceeded(grant.fence, result);
        }
      }
    } else if (grant.input.jobType === "feishu_pull") {
      const result = await runFeishuPullJob(grant, outputDeps(grant));
      finishSucceeded(grant.fence, result);
    } else if (grant.input.jobType === "composition_provider") {
      await runCompositionProvider(grant, controller.signal);
    } else if (grant.input.jobType === "authoring_provider") {
      await runAuthoringProvider(grant, controller.signal);
    } else if (grant.input.jobType === "authoring_transcription") {
      await runAuthoringTranscription(grant, controller.signal);
    } else if (grant.input.jobType === "authoring_probe") {
      await runAuthoringProbe(grant, controller.signal);
    }
  } catch (error) {
    if (error instanceof OutputWaitingError) {
      // The waiting message already moved the job into waiting_input.
    } else if (current.cancelled || (error instanceof WorkerTaskError && error.code === "JOB_CANCELLED")) {
      finishCancelled(grant.fence);
    } else {
      const normalized = normalizeOutputError(error);
      const code = normalized.code;
      const retryable = normalized.retryable;
      if (code === "MODEL_RESULT_UNKNOWN") {
        finishWaitingInput(grant.fence, code, formatError(error));
      } else {
        finishFailed(grant.fence, code, formatError(error), retryable);
      }
      exitAfterStaleLease = code === "JOB_STALE_LEASE";
    }
  } finally {
    stopHeartbeat();
    await media.terminateAll().catch(() => undefined);
    media.reset();
    active = null;
    if (exitAfterStaleLease) {
      setTimeout(() => process.exit(70), 25);
    }
  }
}

function outputDeps(grant: JobGrant): OutputJobDeps {
  return {
    emitCheckpoint: (checkpoint) => sendCheckpoint(grant.fence, checkpoint),
    emitProgress: (phase, done, total, message) => {
      sendEvent(grant.fence, "progress", phase, done, total, { kind: "progress", message });
    },
    waitForInput: async (checkpoint, reason, message) => {
      const result = await sendMessageWithAck({
        schemaVersion: 1,
        type: "waiting",
        messageId: randomUUID(),
        fence: grant.fence,
        reason,
        message,
        checkpoint,
      });
      if (!result.accepted) {
        throw new WorkerTaskError("JOB_STALE_LEASE", "等待输入状态未获调度端确认");
      }
    },
    withRemoteOperation: async (input, action) => {
      const operationId = randomUUID();
      const prepared = await sendMessageWithAck({
        schemaVersion: 1,
        type: "remote_operation",
        messageId: randomUUID(),
        fence: grant.fence,
        operationId,
        kind: input.kind,
        state: "prepare",
        requestHash: input.requestHash,
        clientToken: input.clientToken,
      });
      if (!prepared.accepted) throw new WorkerTaskError("JOB_STALE_LEASE", "远端操作准备未获确认");
      const dispatched = await sendMessageWithAck({
        schemaVersion: 1,
        type: "remote_operation",
        messageId: randomUUID(),
        fence: grant.fence,
        operationId,
        kind: input.kind,
        state: "dispatched",
        requestHash: input.requestHash,
        clientToken: input.clientToken,
      });
      if (!dispatched.accepted) throw new WorkerTaskError("JOB_STALE_LEASE", "远端操作派发未获确认");
      try {
        const response = await action();
        await sendMessageWithAck({
          schemaVersion: 1,
          type: "remote_operation",
          messageId: randomUUID(),
          fence: grant.fence,
          operationId,
          kind: input.kind,
          state: "confirmed",
          requestHash: input.requestHash,
          clientToken: input.clientToken,
          response: summarizeRemoteResponse(response),
        });
        return response;
      } catch (error) {
        const definitive = isDefinitiveRemoteError(error);
        await sendMessageWithAck({
          schemaVersion: 1,
          type: "remote_operation",
          messageId: randomUUID(),
          fence: grant.fence,
          operationId,
          kind: input.kind,
          state: definitive ? "confirmed" : "unknown",
          requestHash: input.requestHash,
          clientToken: input.clientToken,
          response: { error: formatError(error) },
        });
        if (definitive) throw error;
        throw new RemoteResultUnknownError(formatError(error));
      }
    },
  };
}

function summarizeRemoteResponse(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return { count: value.length };
  const record = value as Record<string, unknown>;
  return {
    ...("documentId" in record ? { documentId: record.documentId } : {}),
    ...("revisionId" in record ? { revisionId: record.revisionId } : {}),
    ...("children" in record && Array.isArray(record.children) ? { childCount: record.children.length } : {}),
  };
}

function isDefinitiveRemoteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("status" in error && typeof error.status === "number") {
    const status = error.status;
    return status >= 400 && status < 500 && status !== 429;
  }
  return false;
}

function normalizeOutputError(error: unknown): { code: WorkerTaskError["code"]; retryable: boolean } {
  if (error instanceof WorkerTaskError) return { code: error.code, retryable: error.retryable };
  if (error instanceof RemoteResultUnknownError) {
    return { code: "REMOTE_RESULT_UNKNOWN", retryable: true };
  }
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const status = error.status;
    if (status === 401 || status === 403) return { code: "FEISHU_AUTH_MISSING", retryable: false };
    if (status === 429) return { code: "REMOTE_RESULT_UNKNOWN", retryable: true };
    if (status >= 500) return { code: "REMOTE_RESULT_UNKNOWN", retryable: true };
    return { code: "UNSUPPORTED_FORMAT", retryable: false };
  }
  return { code: "INTERNAL_ERROR", retryable: true };
}

function sendMessageWithAck(
  message: Extract<WorkerToHostMessage, { messageId: string }>,
): Promise<{ accepted: boolean; code: string | null }> {
  if (!process.connected || typeof process.send !== "function") {
    return Promise.resolve({ accepted: false, code: "INTERNAL_ERROR" });
  }
  return new Promise((resolve) => {
    pendingAcks.set(message.messageId, resolve);
    process.send?.(message, (error) => {
      if (error === null || error === undefined) return;
      const pending = pendingAcks.get(message.messageId);
      if (pending !== undefined) {
        pendingAcks.delete(message.messageId);
        pending({ accepted: false, code: "INTERNAL_ERROR" });
      }
    });
  });
}

async function runScan(grant: JobGrant, signal: AbortSignal): Promise<void> {
  const result = await runScanJob(grant, {
    cancelled: () => active?.cancelled === true || signal.aborted,
    emitItem: async (item) => {
      await sendItemResult({
        schemaVersion: 1,
        type: "item_result",
        messageId: randomUUID(),
        fence: grant.fence,
        kind: "scan_item",
        item,
        stagedFiles: [],
      });
    },
    emitCheckpoint: (checkpoint) => sendCheckpoint(grant.fence, checkpoint),
  });
  const scanId = grant.input.jobType === "local_scan" ? grant.input.scanId : "";
  finishSucceeded(grant.fence, {
    schemaVersion: 1,
    jobType: "local_scan",
    scanId,
    counts: {
      candidate: result.counts.candidate,
      excluded: result.counts.excluded,
      unsupported: result.counts.unsupported,
      unreadable: result.counts.unreadable,
      mp4: result.counts.mp4,
      gif: result.counts.gif,
      image: result.counts.image,
      markdown: result.counts.markdown,
      totalBytes: result.counts.totalBytes,
    },
    manifestHash: result.manifestHash,
  });
}

async function runImport(grant: JobGrant, signal: AbortSignal): Promise<void> {
  if (grant.input.jobType !== "local_import") return;
  const result = await runImportJob(grant, media, {
    cancelled: () => active?.cancelled === true || signal.aborted,
    signal,
    sendItemResult: (message) => sendItemResult(message),
    emitCheckpoint: (checkpoint) => sendCheckpoint(grant.fence, checkpoint),
  });
  const jobResult: JobResult = {
    schemaVersion: 1,
    jobType: "local_import",
    importId: grant.input.importId,
    committed: result.committed,
    skipped: 0,
    failed: result.failed,
    assetIds: [],
  };
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence: grant.fence,
    state: result.failed === 0 ? "succeeded" : result.committed > 0 ? "partial" : "failed",
    result: jobResult,
    error:
      result.failed === 0
        ? null
        : {
            code: "SOURCE_UNREADABLE",
            message: `${result.failed} 项导入失败，可逐项重试`,
            retryable: true,
          },
  });
}

async function runTemplateValidationGrant(grant: JobGrant, signal: AbortSignal): Promise<void> {
  const result = await runTemplateValidation(grant, signal);
  if (result.jobType !== "template_validate") {
    throw new WorkerTaskError("INTERNAL_ERROR", "模板验证结果类型不匹配");
  }
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence: grant.fence,
    state: result.ok ? "succeeded" : "failed",
    result,
    error: result.ok
      ? null
      : {
          code: "TEMPLATE_INVALID",
          message: result.message,
          retryable: false,
        },
  });
}

async function runCompositionProvider(grant: JobGrant, signal: AbortSignal): Promise<void> {
  if (grant.input.jobType !== "composition_provider") return;
  const input = grant.input;
  sendEvent(grant.fence, "progress", input.task, null, null, { kind: "progress", message: input.task === "intent" ? "正在理解创作要求" : input.task === "recommend" ? "正在从真实候选推荐方案" : "正在撰写确认方案的全文" });
  const response = await callCompositionModel({ fence: grant.fence, task: input.task,
    purpose: input.task === "intent" || input.task === "recommend" ? "planning" : "generation",
    callOrdinal: 0, provider: input.provider, envelope: input.requestEnvelope, signal });
  finishSucceeded(grant.fence, { schemaVersion: 1, jobType: "composition_provider", contentId: input.contentId,
    renditionId: input.renditionId, inputId: input.inputId, response: response.parsed, rawResponse: response.rawResponse,
    responseHash: response.responseHash, providerRequestId: response.providerRequestId, cost: response.cost });
}

async function runAuthoringProvider(grant: JobGrant, signal: AbortSignal): Promise<void> {
  if (grant.input.jobType !== "authoring_provider") return;
  sendEvent(grant.fence, "progress", "provider", null, null, {
    kind: "progress",
    message: "已取得固定输入，等待 API 的模型调用 permit",
  });
  const purpose = grant.input.task === "plan"
    ? "planning"
    : grant.input.task === "revise"
      ? "revision"
      : "generation";
  const response = await callTextModel({
    fence: grant.fence,
    purpose,
    callOrdinal: 0,
    provider: grant.input.provider,
    envelope: grant.input.requestEnvelope,
    signal,
  });
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence: grant.fence,
    state: "succeeded",
    result: {
      schemaVersion: 1,
      jobType: "authoring_provider",
      contentId: grant.input.contentId,
      renditionId: grant.input.renditionId,
      inputId: grant.input.inputId,
      operations: response.parsed.operations,
      claims: response.parsed.claims,
      rawResponse: response.rawResponse,
      responseHash: response.responseHash,
      providerRequestId: response.providerRequestId,
      cost: response.cost,
    },
    error: null,
  });
}

async function runAuthoringTranscription(grant: JobGrant, signal: AbortSignal): Promise<void> {
  if (grant.input.jobType !== "authoring_transcription") return;
  const response = await callAsrModel({
    fence: grant.fence,
    provider: grant.input.provider,
    envelope: grant.input.requestEnvelope,
    audioBase64: grant.input.audioBase64,
    mimeType: grant.input.mimeType,
    language: grant.input.language,
    signal,
  });
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence: grant.fence,
    state: "succeeded",
    result: {
      schemaVersion: 1,
      jobType: "authoring_transcription",
      contentId: grant.input.contentId,
      text: response.text,
      rawResponse: response.rawResponse,
      responseHash: response.responseHash,
      providerRequestId: response.providerRequestId,
      cost: response.cost,
    },
    error: null,
  });
}

async function runAuthoringProbe(grant: JobGrant, signal: AbortSignal): Promise<void> {
  if (grant.input.jobType !== "authoring_probe") return;
  const result = await probeTextModel({
    fence: grant.fence,
    provider: grant.input.provider,
    envelope: grant.input.requestEnvelope,
    signal,
  });
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence: grant.fence,
    state: "succeeded",
    result: {
      schemaVersion: 1,
      jobType: "authoring_probe",
      providerId: grant.input.provider.providerId,
      ok: true,
      rawResponse: result.rawResponse,
      responseHash: result.responseHash,
      cost: result.cost,
    },
    error: null,
  });
}

function sendItemResult(message: ItemResultMessage): Promise<{ accepted: boolean; code: string | null }> {
  if (!process.connected || typeof process.send !== "function") {
    return Promise.resolve({ accepted: false, code: "INTERNAL_ERROR" });
  }
  return new Promise((resolve) => {
    pendingAcks.set(message.messageId, resolve);
    process.send?.(message, (error) => {
      if (error === null || error === undefined) return;
      const pending = pendingAcks.get(message.messageId);
      if (pending !== undefined) {
        pendingAcks.delete(message.messageId);
        pending({ accepted: false, code: "INTERNAL_ERROR" });
      }
    });
  });
}

async function runLocalProbe(grant: JobGrant): Promise<void> {
  const completed =
    grant.checkpoint?.jobType === "local_env_probe"
      ? new Set(grant.checkpoint.completedSteps)
      : new Set<string>();
  const steps = ["node", "platform", "sharp", "png"];
  for (const step of steps) {
    if (active?.cancelled === true) {
      finishCancelled(grant.fence);
      return;
    }
    if (!completed.has(step)) {
      await sleep(15);
      completed.add(step);
      sendCheckpoint(grant.fence, {
        schemaVersion: 1,
        jobType: "local_env_probe",
        completedSteps: [...completed],
      });
      sendEvent(grant.fence, "progress", "local_env_probe", null, null, {
        kind: "progress",
        message: `本机能力检查：${step}`,
      });
    }
  }
  const png = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 124, g: 58, b: 237, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  finishSucceeded(grant.fence, {
    schemaVersion: 1,
    jobType: "local_env_probe",
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    sharpVersion: sharp.versions.sharp,
    pngBytes: png.byteLength,
    pngSha256: createHash("sha256").update(png).digest("hex"),
  });
}

async function runFixture(grant: JobGrant): Promise<void> {
  const checkpoint: FixtureCheckpoint =
    grant.checkpoint?.jobType === "fixture_long"
      ? grant.checkpoint
      : { schemaVersion: 1, jobType: "fixture_long", cursor: 0, digest: emptyDigest() };
  if (grant.input.jobType !== "fixture_long") throw new Error("fixture grant type mismatch");
  let cursor = checkpoint.cursor;
  let digest = checkpoint.digest;
  for (let index = cursor; index < grant.input.steps; index += 1) {
    if (active?.cancelled === true) {
      finishCancelled(grant.fence);
      return;
    }
    await sleep(grant.input.stepMs);
    if (grant.input.failAt !== undefined && grant.input.failAt === index + 1) {
      finishFailed(grant.fence, "INTERNAL_ERROR", "fixture 到达预定失败点", false);
      return;
    }
    cursor = index + 1;
    digest = createHash("sha256").update(`${grant.jobId}:${cursor}`).digest("hex");
    sendCheckpoint(grant.fence, {
      schemaVersion: 1,
      jobType: "fixture_long",
      cursor,
      digest,
    });
    sendEvent(grant.fence, "progress", "fixture", cursor, grant.input.steps, {
      kind: "progress",
      message: `已完成 ${cursor}/${grant.input.steps}`,
    });
  }
  finishSucceeded(grant.fence, {
    schemaVersion: 1,
    jobType: "fixture_long",
    completedSteps: cursor,
    digest,
  });
}

function startHeartbeat(fence: WorkerFence): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    send({
      schemaVersion: 1,
      type: "heartbeat",
      messageId: randomUUID(),
      fence,
      sentAt: new Date().toISOString(),
    });
  }, 10_000);
  heartbeatTimer.unref();
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendCheckpoint(
  fence: WorkerFence,
  checkpoint: ScanCheckpoint | ImportCheckpoint | JobGrant["checkpoint"],
): void {
  if (checkpoint === null) return;
  send({
    schemaVersion: 1,
    type: "checkpoint",
    messageId: randomUUID(),
    fence,
    checkpoint,
  });
}

function sendEvent(
  fence: WorkerFence,
  kind: "progress" | "warning",
  phase: string,
  done: number | null,
  total: number | null,
  payload: JobEventPayload,
): void {
  send({
    schemaVersion: 1,
    type: "event",
    messageId: randomUUID(),
    fence,
    kind,
    phase,
    done,
    total,
    payload,
  });
}

function finishSucceeded(fence: WorkerFence, result: JobResult): void {
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence,
    state: "succeeded",
    result,
    error: null,
  });
}

function finishPartial(
  fence: WorkerFence,
  result: JobResult,
  error: { code: WorkerTaskError["code"]; message: string; retryable: boolean },
): void {
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence,
    state: "partial",
    result,
    error,
  });
}

function finishFailed(
  fence: WorkerFence,
  code: WorkerTaskError["code"],
  message: string,
  retryable: boolean,
): void {
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence,
    state: "failed",
    result: null,
    error: { code, message, retryable },
  });
}

function finishWaitingInput(
  fence: WorkerFence,
  code: WorkerTaskError["code"],
  message: string,
): void {
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence,
    state: "waiting_input",
    result: null,
    error: { code, message, retryable: false },
  });
}

function finishCancelled(fence: WorkerFence): void {
  send({
    schemaVersion: 1,
    type: "finished",
    messageId: randomUUID(),
    fence,
    state: "cancelled",
    result: null,
    error: null,
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDownPromise !== null) return shuttingDownPromise;
  shuttingDown = true;
  stopHeartbeat();
  active?.controller.abort();
  shuttingDownPromise = (async () => {
    await media.terminateAll().catch(() => undefined);
    if (process.connected) process.disconnect();
    process.exit(0);
  })();
  return shuttingDownPromise;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyDigest(): string {
  return createHash("sha256").update("fixture").digest("hex");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "未知 worker 错误";
}
