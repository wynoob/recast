import { createHash, randomUUID } from "node:crypto";
import {
  ClaimSchema,
  parseCompositionResponse,
  type CompositionTask,
  AuthoringOperationSchema,
  type HostToWorkerMessage,
  type WorkerCallIntent,
  type WorkerCallResult,
  type WorkerFence,
} from "@dmall/contracts";
import { z } from "zod";
import { WorkerTaskError } from "../task-error.js";

interface Permit {
  attemptId: string;
  logicalCallId: string;
  requestHash: string;
  retransmit: boolean;
}

const pendingPermits = new Map<string, {
  resolve: (permit: Permit) => void;
  reject: (error: Error) => void;
}>();
const pendingResultAcks = new Map<string, (accepted: boolean, code: string | null) => void>();
const pendingRequestHash = new Map<string, string>();
const promiseCleanup = new Map<string, () => void>();

export function acceptProviderMessage(message: HostToWorkerMessage): boolean {
  if (message.type === "call_permit") {
    const pending = pendingPermits.get(message.intentMessageId);
    if (pending === undefined) return true;
    pendingPermits.delete(message.intentMessageId);
    if (message.requestHash === pendingRequestHash.get(message.intentMessageId)) {
      pendingRequestHash.delete(message.intentMessageId);
      pending.resolve({
        attemptId: message.attemptId,
        logicalCallId: message.logicalCallId,
        requestHash: message.requestHash,
        retransmit: message.retransmit,
      });
    } else {
      pending.reject(new WorkerTaskError("CALL_IDENTITY_CONFLICT", "模型 permit 的请求 hash 不一致"));
    }
    return true;
  }
  if (message.type === "ack") {
    const pending = pendingResultAcks.get(message.messageId);
    if (pending !== undefined) {
      pendingResultAcks.delete(message.messageId);
      pending(message.accepted, message.code);
    }
    const permit = pendingPermits.get(message.messageId);
    if (permit !== undefined && !message.accepted) {
      pendingPermits.delete(message.messageId);
      pendingRequestHash.delete(message.messageId);
      permit.reject(new WorkerTaskError(
        message.code === "CALL_IDENTITY_CONFLICT" ? "CALL_IDENTITY_CONFLICT" : "MODEL_RESULT_UNKNOWN",
        message.code === "CALL_IDENTITY_CONFLICT"
          ? "模型调用身份冲突"
          : "模型调用未被 API permit，未发送请求",
      ));
    }
    return true;
  }
  return false;
}

async function callTextTransport(input: {
  fence: WorkerFence;
  purpose: "planning" | "generation" | "revision";
  callOrdinal: number;
  provider: {
    baseUrl: string;
    modelId: string;
    credentialEnv: string;
    timeoutMs: number;
  };
  envelope: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{
  rawResponse: string;
  responseHash: string;
  providerRequestId: string | null;
  cost: number | null;
}> {
  const credential = process.env[input.provider.credentialEnv];
  if (credential === undefined || credential === "") {
    throw new WorkerTaskError(
      "MODEL_CAPABILITY_MISSING",
      `未配置文本模型凭证环境变量 ${input.provider.credentialEnv}，请求未发送`,
      false,
    );
  }
  const requestHash = `rh1:${sha256(stableJson(input.envelope))}`;
  const permit = await requestPermit(input.fence, input.purpose, input.callOrdinal, requestHash, input.envelope, input.signal);
  if (input.signal.aborted) {
    throw new WorkerTaskError("JOB_CANCELLED", "任务已取消，模型请求未发送", false);
  }
  const endpoint = chatEndpoint(input.provider.baseUrl);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({
        model: input.provider.modelId,
        messages: input.envelope.messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.provider.timeoutMs)]),
    });
  } catch (error) {
    if (input.signal.aborted) throw new WorkerTaskError("JOB_CANCELLED", "任务已取消", false);
    throw new WorkerTaskError(
      "MODEL_RESULT_UNKNOWN",
      `模型请求已发送但结果未知：${error instanceof Error ? error.message : "网络错误"}`,
      false,
    );
  }
  const rawResponse = await response.text();
  const responseHash = `resp1:${sha256(rawResponse)}`;
  const providerRequestId = response.headers.get("x-request-id");
  const cost = readCost(rawResponse);
  await sendCallResult({
    fence: input.fence,
    attemptId: permit.attemptId,
    logicalCallId: permit.logicalCallId,
    requestHash,
    responseHash,
    rawResponse,
    providerRequestId,
    cost,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new WorkerTaskError("MODEL_CAPABILITY_MISSING", `模型凭证被拒绝（HTTP ${response.status}）`, false);
    }
    if (response.status === 429) {
      throw new WorkerTaskError("MODEL_RESULT_UNKNOWN", "模型限流，结果未完成；不自动重发", false);
    }
    if (response.status >= 500) {
      throw new WorkerTaskError("MODEL_RESULT_UNKNOWN", `模型返回 HTTP ${response.status}，结果未知`, false);
    }
    throw new WorkerTaskError("MODEL_SCHEMA_INVALID", `模型请求失败（HTTP ${response.status}）`, false);
  }
  return { rawResponse, responseHash, providerRequestId, cost };
}

export async function callTextModel(input: Parameters<typeof callTextTransport>[0]) {
  const response = await callTextTransport(input);
  return { ...response, parsed: parseAuthoringResponse(response.rawResponse) };
}

export async function callCompositionModel(input: Parameters<typeof callTextTransport>[0] & { task: CompositionTask }) {
  const response = await callTextTransport(input);
  try {
    return { ...response, parsed: parseCompositionResponse(input.task, response.rawResponse) };
  } catch {
    throw new WorkerTaskError("MODEL_SCHEMA_INVALID", "模型返回的创作 JSON 不符合固定响应契约", false);
  }
}

export async function callAsrModel(input: {
  fence: WorkerFence;
  provider: {
    baseUrl: string;
    modelId: string;
    credentialEnv: string;
    timeoutMs: number;
  };
  envelope: Record<string, unknown>;
  audioBase64: string;
  mimeType: string;
  language: string;
  signal: AbortSignal;
}): Promise<{
  text: string;
  rawResponse: string;
  responseHash: string;
  providerRequestId: string | null;
  cost: number | null;
}> {
  const credential = process.env[input.provider.credentialEnv];
  if (credential === undefined || credential === "") {
    throw new WorkerTaskError(
      "MODEL_CAPABILITY_MISSING",
      `未配置语音转写凭证环境变量 ${input.provider.credentialEnv}，请求未发送`,
      false,
    );
  }
  const requestHash = `rh1:${sha256(stableJson(input.envelope))}`;
  const permit = await requestPermit(input.fence, "transcription", 0, requestHash, input.envelope, input.signal);
  if (input.signal.aborted) throw new WorkerTaskError("JOB_CANCELLED", "任务已取消，转写请求未发送", false);
  const form = new FormData();
  form.set("model", input.provider.modelId);
  form.set("language", input.language);
  form.set("file", new Blob([Buffer.from(input.audioBase64, "base64")], { type: input.mimeType }), "audio");
  let response: Response;
  try {
    response = await fetch(asrEndpoint(input.provider.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      body: form,
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.provider.timeoutMs)]),
    });
  } catch (error) {
    if (input.signal.aborted) throw new WorkerTaskError("JOB_CANCELLED", "任务已取消", false);
    throw new WorkerTaskError(
      "MODEL_RESULT_UNKNOWN",
      `转写请求已发送但结果未知：${error instanceof Error ? error.message : "网络错误"}`,
      false,
    );
  }
  const rawResponse = await response.text();
  const responseHash = `resp1:${sha256(rawResponse)}`;
  const providerRequestId = response.headers.get("x-request-id");
  const cost = readCost(rawResponse);
  await sendCallResult({
    fence: input.fence,
    attemptId: permit.attemptId,
    logicalCallId: permit.logicalCallId,
    requestHash,
    responseHash,
    rawResponse,
    providerRequestId,
    cost,
  });
  if (!response.ok) {
    throw new WorkerTaskError(
      response.status === 401 || response.status === 403 ? "MODEL_CAPABILITY_MISSING" : "MODEL_RESULT_UNKNOWN",
      `转写请求失败（HTTP ${response.status}）`,
      false,
    );
  }
  const parsed = z.object({ text: z.string().min(1) }).safeParse(JSON.parse(rawResponse) as unknown);
  if (!parsed.success) {
    throw new WorkerTaskError("MODEL_SCHEMA_INVALID", "转写响应不符合 text schema", false);
  }
  return { text: parsed.data.text, rawResponse, responseHash, providerRequestId, cost };
}

export async function probeTextModel(input: {
  fence: WorkerFence;
  provider: {
    baseUrl: string;
    modelId: string;
    credentialEnv: string;
    timeoutMs: number;
  };
  envelope: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{
  rawResponse: string;
  responseHash: string;
  cost: number | null;
}> {
  const credential = process.env[input.provider.credentialEnv];
  if (credential === undefined || credential === "") {
    throw new WorkerTaskError(
      "MODEL_CAPABILITY_MISSING",
      `未配置文本模型凭证环境变量 ${input.provider.credentialEnv}，探针未发送`,
      false,
    );
  }
  const requestHash = `rh1:${sha256(stableJson(input.envelope))}`;
  const permit = await requestPermit(input.fence, "probe", 0, requestHash, input.envelope, input.signal);
  let response: Response;
  try {
    response = await fetch(chatEndpoint(input.provider.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({
        model: input.provider.modelId,
        messages: input.envelope.messages,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.provider.timeoutMs)]),
    });
  } catch (error) {
    if (input.signal.aborted) throw new WorkerTaskError("JOB_CANCELLED", "任务已取消", false);
    throw new WorkerTaskError("MODEL_RESULT_UNKNOWN", "模型探针已发送但结果未知", false);
  }
  const rawResponse = await response.text();
  const responseHash = `resp1:${sha256(rawResponse)}`;
  await sendCallResult({
    fence: input.fence,
    attemptId: permit.attemptId,
    logicalCallId: permit.logicalCallId,
    requestHash,
    responseHash,
    rawResponse,
    providerRequestId: response.headers.get("x-request-id"),
    cost: readCost(rawResponse),
  });
  if (!response.ok) {
    throw new WorkerTaskError(
      response.status === 401 || response.status === 403 ? "MODEL_CAPABILITY_MISSING" : "MODEL_RESULT_UNKNOWN",
      `模型探针失败（HTTP ${response.status}）`,
      false,
    );
  }
  return { rawResponse, responseHash, cost: readCost(rawResponse) };
}

async function requestPermit(
  fence: WorkerFence,
  purpose: WorkerCallIntent["purpose"],
  callOrdinal: number,
  requestHash: string,
  requestEnvelope: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Permit> {
  if (!process.connected || typeof process.send !== "function") {
    throw new WorkerTaskError("INTERNAL_ERROR", "worker IPC 已关闭", false);
  }
  const messageId = randomUUID();
  const promise = new Promise<Permit>((resolve, reject) => {
    pendingPermits.set(messageId, { resolve, reject });
    pendingRequestHash.set(messageId, requestHash);
    const onAbort = () => {
      pendingPermits.delete(messageId);
      pendingRequestHash.delete(messageId);
      reject(new WorkerTaskError("JOB_CANCELLED", "等待模型 permit 时任务取消", false));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promiseCleanup.set(messageId, () => signal.removeEventListener("abort", onAbort));
  });
  const message: WorkerCallIntent = {
    schemaVersion: 1,
    type: "call_intent",
    messageId,
    fence,
    purpose,
    callOrdinal,
    requestHash,
    requestEnvelope,
  };
  process.send(message, (error) => {
    if (error === null || error === undefined) return;
    const pending = pendingPermits.get(messageId);
    if (pending !== undefined) {
      pendingPermits.delete(messageId);
      pendingRequestHash.delete(messageId);
      pending.reject(new WorkerTaskError("INTERNAL_ERROR", "模型 permit 请求发送失败", true));
    }
  });
  return promise.finally(() => {
    promiseCleanup.get(messageId)?.();
    promiseCleanup.delete(messageId);
  });
}

async function sendCallResult(input: Omit<WorkerCallResult, "schemaVersion" | "type" | "messageId">): Promise<void> {
  if (!process.connected || typeof process.send !== "function") {
    throw new WorkerTaskError("INTERNAL_ERROR", "worker IPC 已关闭", false);
  }
  const message: WorkerCallResult = {
    schemaVersion: 1,
    type: "call_result",
    messageId: randomUUID(),
    ...input,
  };
  const ack = new Promise<{ accepted: boolean; code: string | null }>((resolve) => {
    pendingResultAcks.set(message.messageId, (accepted, code) => resolve({ accepted, code }));
  });
  process.send(message);
  const result = await ack;
  if (!result.accepted) {
    throw new WorkerTaskError("MODEL_RESULT_UNKNOWN", "API 未确认模型结果，结果可能为迟到响应", false);
  }
}

function parseAuthoringResponse(raw: string): { operations: import("@dmall/contracts").AuthoringOperation[]; claims: import("@dmall/contracts").Claim[] } {
  let root: unknown;
  try {
    const envelope = z.object({
      choices: z.array(z.object({
        message: z.object({ content: z.string() }),
      })).min(1),
    }).parse(JSON.parse(raw) as unknown);
    root = JSON.parse(envelope.choices[0]!.message.content) as unknown;
  } catch {
    throw new WorkerTaskError("MODEL_SCHEMA_INVALID", "模型响应不是有效 JSON", false);
  }
  const parsed = z.object({
    operations: z.array(AuthoringOperationSchema).min(1),
    claims: z.array(ClaimSchema).default([]),
  }).safeParse(root);
  if (!parsed.success) {
    throw new WorkerTaskError("MODEL_SCHEMA_INVALID", "模型 operations 不符合 AuthoringOperation schema", false);
  }
  return parsed.data;
}

function chatEndpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/+$/, "");
  return value.endsWith("/chat/completions") ? value : `${value}/chat/completions`;
}

function asrEndpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/+$/, "");
  return value.endsWith("/audio/transcriptions") ? value : `${value}/audio/transcriptions`;
}

function readCost(raw: string): number | null {
  try {
    const value = JSON.parse(raw) as { usage?: { cost?: unknown } };
    return typeof value.usage?.cost === "number" && Number.isFinite(value.usage.cost)
      ? value.usage.cost
      : null;
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
