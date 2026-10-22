import { z } from "zod";
import {
  ApiSuccessSchema,
  AssetDetailV2Schema,
  AssetListSchema,
  AssetPatchResultSchema,
  ImportDetailSchema,
  JobSnapshotSchema,
  ScanDetailSchema,
  ScanItemViewSchema,
  SearchResponseSchema,
  SelectionViewSchema,
  SourceListSchema,
  SourceContextSchema,
  UploadChunkResultSchema,
  type AssetAvailability,
  type AssetDetailV2,
  type AssetMapSelection,
  type AssetList,
  type AssetPatchResult,
  type ImportDetail,
  type ImportSelection,
  type JobSnapshot,
  type ScanDetail,
  type SearchResponse,
  type SelectionView,
  type ScanCreateRequest,
  type SourceList,
  type SourceContext,
  type UploadChunkResult,
} from "@dmall/contracts";
import { ApiClientError } from "../../api.js";

const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

const ScanItemPageSchema = z.strictObject({
  items: z.array(ScanItemViewSchema),
  nextCursor: z.string().nullable(),
  total: z.int().nonnegative(),
});

const ScanCreateResponseSchema = z.strictObject({
  scanId: z.uuid(),
  jobId: z.uuid(),
  status: z.literal("queued"),
});

const ImportCreateResponseSchema = z.strictObject({
  importId: z.uuid(),
  jobId: z.uuid(),
  status: z.enum(["queued", "running", "waiting_input", "succeeded", "partial", "failed", "cancelled"]),
});

export type PatchAssetResult = AssetPatchResult;

export interface AssetListParams {
  q?: string;
  type?: "image" | "gif" | "video";
  state?: AssetAvailability;
  limit?: number;
  cursor?: string | null;
}

export interface ScanItemParams {
  status?: "candidate" | "excluded" | "unsupported" | "unreadable";
  kind?: "image" | "gif" | "video" | "markdown" | "pdf" | "pptx" | "html" | "html_zip" | "unsupported";
  limit?: number;
  cursor?: string | null;
}

export interface SourceListParams {
  kind?: string;
  limit?: number;
  cursor?: string | null;
}

export interface SearchParams {
  query: string;
  merchantId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  mediaKinds: Array<"document" | "image" | "gif" | "video" | "audio">;
  availability: Array<"available" | "missing" | "unsupported">;
}

export function assetListQuery(params: AssetListParams = {}) {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit ?? 20));
  if (params.q !== undefined && params.q.trim() !== "") search.set("q", params.q.trim());
  if (params.type !== undefined) search.set("type", params.type);
  if (params.state !== undefined) search.set("state", params.state);
  if (params.cursor !== undefined && params.cursor !== null && params.cursor !== "") {
    search.set("cursor", params.cursor);
  }
  return {
    queryKey: ["assets", params] as const,
    queryFn: async (): Promise<AssetList> =>
      request(`/api/v1/assets?${search.toString()}`, AssetListSchema),
  };
}

export function assetDetailQuery(id: string) {
  return {
    queryKey: ["asset", id] as const,
    queryFn: async (): Promise<AssetDetailV2> =>
      request(`/api/v1/assets/${encodeURIComponent(id)}`, AssetDetailV2Schema),
  };
}

export function sourceListQuery(params: SourceListParams = {}) {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit ?? 20));
  if (params.kind !== undefined && params.kind !== "") search.set("kind", params.kind);
  if (params.cursor !== undefined && params.cursor !== null && params.cursor !== "") {
    search.set("cursor", params.cursor);
  }
  return {
    queryKey: ["sources", params] as const,
    queryFn: async (): Promise<SourceList> =>
      request(`/api/v1/sources?${search.toString()}`, SourceListSchema),
  };
}

export function scanDetailQuery(scanId: string) {
  return {
    queryKey: ["scan", scanId] as const,
    queryFn: async (): Promise<ScanDetail> =>
      request(`/api/v1/imports/scans/${encodeURIComponent(scanId)}`, ScanDetailSchema),
  };
}

export function scanItemsQuery(scanId: string, params: ScanItemParams = {}) {
  const search = new URLSearchParams();
  search.set("limit", String(params.limit ?? 12));
  if (params.status !== undefined) search.set("status", params.status);
  if (params.kind !== undefined) search.set("kind", params.kind);
  if (params.cursor !== undefined && params.cursor !== null && params.cursor !== "") {
    search.set("cursor", params.cursor);
  }
  return {
    queryKey: ["scan-items", scanId, params] as const,
    queryFn: async (): Promise<z.infer<typeof ScanItemPageSchema>> =>
      request(
        `/api/v1/imports/scans/${encodeURIComponent(scanId)}/items?${search.toString()}`,
        ScanItemPageSchema,
      ),
  };
}

export function importDetailQuery(importId: string, cursor: string | null = null) {
  const search = new URLSearchParams({ limit: "100" });
  if (cursor !== null) search.set("cursor", cursor);
  return {
    queryKey: ["import", importId, cursor] as const,
    queryFn: async (): Promise<ImportDetail> =>
      request(
        `/api/v1/imports/${encodeURIComponent(importId)}?${search.toString()}`,
        ImportDetailSchema,
      ),
  };
}

export function jobQuery(jobId: string) {
  return {
    queryKey: ["job", jobId] as const,
    queryFn: async (): Promise<JobSnapshot> =>
      request(`/api/v1/jobs/${encodeURIComponent(jobId)}`, JobSnapshotSchema),
  };
}

export function sourceContextQuery(sourceId: string, versionId?: string) {
  const search = new URLSearchParams();
  if (versionId !== undefined) search.set("versionId", versionId);
  const suffix = search.size === 0 ? "" : `?${search.toString()}`;
  return {
    queryKey: ["source", sourceId, versionId ?? null] as const,
    queryFn: async (): Promise<SourceContext> =>
      request(
        `/api/v1/sources/${encodeURIComponent(sourceId)}${suffix}`,
        SourceContextSchema,
      ),
  };
}

export function selectionQuery(handleId: string) {
  return {
    queryKey: ["selection", handleId] as const,
    queryFn: async (): Promise<SelectionView> =>
      request(`/api/v1/selections/${encodeURIComponent(handleId)}`, SelectionViewSchema),
  };
}

export async function searchContent(input: {
  params: SearchParams;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<SearchResponse> {
  return writeRequest(
    "/api/v1/search",
    "POST",
    input.csrfToken,
    input.idempotencyKey,
    {
      schemaVersion: 1,
      query: input.params.query,
      mode: "keyword",
      limit: 20,
      filters: {
        schemaVersion: 1,
        merchantId: input.params.merchantId === "" ? null : input.params.merchantId,
        dateFrom: input.params.dateFrom === "" ? null : input.params.dateFrom,
        dateTo: input.params.dateTo === "" ? null : input.params.dateTo,
        mediaKinds: input.params.mediaKinds,
        audience: [],
        functions: [],
        obsolete: "exclude",
        availability: input.params.availability,
      },
    },
    SearchResponseSchema,
  );
}

export async function createScan(input: {
  request: ScanCreateRequest;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<{ scanId: string; jobId: string; status: "queued" }> {
  return writeRequest(
    "/api/v1/imports/scan", "POST", input.csrfToken, input.idempotencyKey,
    input.request, ScanCreateResponseSchema,
  );
}

export async function createImport(input: {
  scanId: string;
  selection: ImportSelection;
  assetMap?: AssetMapSelection;
  csrfToken: string;
}): Promise<{ importId: string; jobId: string; status: string }> {
  return writeRequest(
    "/api/v1/imports",
    "POST",
    input.csrfToken,
    uuid(),
    {
      schemaVersion: 1,
      scanId: input.scanId,
      selection: input.selection,
      ...(input.assetMap === undefined ? {} : { assetMap: input.assetMap }),
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
    },
    ImportCreateResponseSchema,
  );
}

export async function retryImport(input: {
  importId: string;
  itemIds: string[];
  csrfToken: string;
}): Promise<JobSnapshot> {
  return writeRequest(
    `/api/v1/imports/${encodeURIComponent(input.importId)}/retry`,
    "POST",
    input.csrfToken,
    uuid(),
    { schemaVersion: 1, itemIds: input.itemIds },
    JobSnapshotSchema,
  );
}

export async function cancelJob(input: {
  jobId: string;
  csrfToken: string;
}): Promise<JobSnapshot> {
  return writeRequest(
    `/api/v1/jobs/${encodeURIComponent(input.jobId)}/cancel`,
    "POST",
    input.csrfToken,
    uuid(),
    {},
    JobSnapshotSchema,
  );
}

export async function resumeJob(input: {
  jobId: string;
  csrfToken: string;
}): Promise<JobSnapshot> {
  return writeRequest(
    `/api/v1/jobs/${encodeURIComponent(input.jobId)}/resume`,
    "POST",
    input.csrfToken,
    uuid(),
    {},
    JobSnapshotSchema,
  );
}

export async function patchAsset(input: {
  id: string;
  expectedVersion: number;
  title?: string;
  tags?: string[];
  csrfToken: string;
  idempotencyKey: string;
}): Promise<PatchAssetResult> {
  const body: {
    schemaVersion: 1;
    expectedVersion: number;
    title?: string;
    tags?: string[];
  } = { schemaVersion: 1, expectedVersion: input.expectedVersion };
  if (input.title !== undefined) body.title = input.title;
  if (input.tags !== undefined) body.tags = input.tags;
  return writeRequest(
    `/api/v1/assets/${encodeURIComponent(input.id)}`,
    "PATCH",
    input.csrfToken,
    input.idempotencyKey,
    body,
    AssetPatchResultSchema,
  );
}

export interface UploadProgress {
  chunkIndex: number;
  chunkCount: number;
  receivedBytes: number;
  totalBytes: number;
}

export async function uploadFile(input: {
  file: File;
  relativePath: string;
  csrfToken: string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<UploadChunkResult> {
  const chunkCount = Math.max(1, Math.ceil(input.file.size / UPLOAD_CHUNK_BYTES));
  let fileId: string | null = null;
  let receivedBytes = 0;
  let result: UploadChunkResult | null = null;

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    if (input.signal?.aborted === true) throw new DOMException("上传已取消", "AbortError");
    const start = chunkIndex * UPLOAD_CHUNK_BYTES;
    const end = Math.min(input.file.size, start + UPLOAD_CHUNK_BYTES);
    const buffer = await input.file.slice(start, end).arrayBuffer();
    input.signal?.throwIfAborted();
    const chunkSha256 = await sha256(buffer);
    input.signal?.throwIfAborted();
    const form = new FormData();
    // The server streams multipart before reading trailing fields, so every metadata field precedes the file part.
    if (fileId === null) {
      form.append("relativePath", input.relativePath);
      form.append("declaredBytes", String(input.file.size));
    } else {
      form.append("fileId", fileId);
    }
    form.append("chunkIndex", String(chunkIndex));
    form.append("chunkCount", String(chunkCount));
    form.append("chunkSha256", chunkSha256);
    form.append("file", new Blob([buffer]), `chunk-${chunkIndex}.part`);

    const response = await fetch("/api/v1/uploads", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "x-csrf-token": input.csrfToken,
        "idempotency-key": uuid(),
      },
      body: form,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.signal?.throwIfAborted();
    const raw = await response.json().catch(() => null);
    input.signal?.throwIfAborted();
    if (!response.ok) {
      const parsed = raw as
        | { error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> } }
        | null;
      throw new ApiClientError({
        status: response.status,
        code: parsed?.error?.code ?? "INTERNAL_ERROR",
        message: parsed?.error?.message ?? "上传失败，请稍后重试",
        retryable: parsed?.error?.retryable ?? false,
        details: parsed?.error?.details ?? {},
      });
    }
    result = ApiSuccessSchema(UploadChunkResultSchema).parse(raw).data;
    fileId = result.fileId;
    receivedBytes = result.receivedBytes;
    input.onProgress?.({
      chunkIndex: chunkIndex + 1,
      chunkCount,
      receivedBytes,
      totalBytes: input.file.size,
    });
  }
  if (result === null || !result.complete) throw new Error("上传没有完成");
  return result;
}

export function isTerminalJobState(state: JobSnapshot["state"]): boolean {
  return state === "succeeded" || state === "partial" || state === "failed" || state === "cancelled";
}

export function conflictDetails(error: unknown): {
  currentVersion: number;
  title: string;
  tags: string[];
  origins: { title: "source" | "manual"; tags: "source" | "manual" };
} | null {
  if (!(error instanceof ApiClientError) || error.code !== "ASSET_VERSION_CONFLICT") return null;
  const currentVersion = error.details.currentVersion;
  const current = error.details.current;
  if (typeof currentVersion !== "number" || typeof current !== "object" || current === null) return null;
  const parsed = z
    .strictObject({
      title: z.string(),
      tags: z.array(z.string()),
      origins: z.strictObject({
        title: z.enum(["source", "manual"]),
        tags: z.enum(["source", "manual"]),
      }),
    })
    .safeParse(current);
  if (!parsed.success) return null;
  return { currentVersion, ...parsed.data };
}

async function request<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  return (await parseEnvelope(response, schema)).data;
}

async function writeRequest<T>(
  url: string,
  method: "POST" | "PATCH",
  csrfToken: string,
  idempotencyKey: string,
  body: unknown,
  dataSchema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return (await parseEnvelope(response, dataSchema)).data;
}

async function parseEnvelope<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<{ data: T; requestId: string }> {
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = raw as
      | { error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> } }
      | null;
    throw new ApiClientError({
      status: response.status,
      code: parsed?.error?.code ?? "INTERNAL_ERROR",
      message: parsed?.error?.message ?? "请求失败，请稍后重试",
      retryable: parsed?.error?.retryable ?? false,
      details: parsed?.error?.details ?? {},
    });
  }
  return ApiSuccessSchema(schema).parse(raw);
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function uuid(): string {
  return crypto.randomUUID();
}
