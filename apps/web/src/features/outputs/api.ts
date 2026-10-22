import {
  ApiSuccessSchema,
  ExportListSchema,
  ExportRecordSchema,
  OutputPreviewSchema,
  ProjectBundleImportRecordSchema,
  PullRecordSchema,
  RevisionListSchema,
  UploadChunkResultSchema,
  type ExportFormat,
  type ExportList,
  type ExportRecord,
  type OutputPreview,
  type ProjectBundleImportRecord,
  type PullRecord,
  type RevisionList,
} from "@dmall/contracts";
import { z } from "zod";
import { parseResponse } from "../../api.js";

function exportOptions(input: {
  speakerNotes: boolean;
  title?: string;
  revisionIds?: string[];
  feishu?: { folderToken?: string };
}): Record<string, unknown> {
  return {
    speakerNotes: input.speakerNotes,
    includeHiddenBlocks: false,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.revisionIds === undefined ? {} : { revisionIds: input.revisionIds }),
    ...(input.feishu === undefined
      ? {}
      : {
          publish: true,
          confirmedCreateDocument: true,
          ...(input.feishu.folderToken === undefined ? {} : { folderToken: input.feishu.folderToken }),
        }),
  };
}

export async function previewOutput(input: {
  renditionId: string;
  revisionId: string;
}): Promise<OutputPreview> {
  const response = await fetch(
    `/api/v1/renditions/${encodeURIComponent(input.renditionId)}/output-preview?revisionId=${encodeURIComponent(input.revisionId)}`,
    { credentials: "same-origin" },
  );
  return (await parseResponse(response, ApiSuccessSchema(OutputPreviewSchema))).data;
}

export async function listExports(input: {
  contentId: string;
  renditionId?: string;
}): Promise<ExportList> {
  const query = new URLSearchParams({ limit: "50" });
  if (input.renditionId !== undefined) query.set("renditionId", input.renditionId);
  const response = await fetch(
    `/api/v1/contents/${encodeURIComponent(input.contentId)}/exports?${query.toString()}`,
    { credentials: "same-origin" },
  );
  return (await parseResponse(response, ApiSuccessSchema(ExportListSchema))).data;
}

export async function createExport(input: {
  csrfToken: string;
  renditionId: string;
  revisionId: string;
  format: ExportFormat;
  speakerNotes: boolean;
  title?: string;
  revisionIds?: string[];
  feishuFolderToken?: string;
}): Promise<{ exportId: string; jobId: string }> {
  const body = {
    schemaVersion: 1,
    renditionId: input.renditionId,
    revisionId: input.revisionId,
    format: input.format,
    options: exportOptions({
      speakerNotes: input.speakerNotes,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.revisionIds === undefined ? {} : { revisionIds: input.revisionIds }),
      ...(input.format === "feishu_doc"
        ? { feishu: { ...(input.feishuFolderToken === undefined ? {} : { folderToken: input.feishuFolderToken }) } }
        : {}),
    }),
  };
  const data = await writeJson<
    { exportId?: string; jobId: string }
  >("/api/v1/exports", input.csrfToken, body);
  if (data.exportId === undefined) throw new Error("导出启动响应缺少 exportId");
  return { exportId: data.exportId, jobId: data.jobId };
}

export async function getExport(exportId: string): Promise<ExportRecord> {
  const response = await fetch(`/api/v1/exports/${encodeURIComponent(exportId)}`, {
    credentials: "same-origin",
  });
  return (await parseResponse(response, ApiSuccessSchema(ExportRecordSchema))).data;
}

export async function retryExport(input: {
  exportId: string;
  csrfToken: string;
}): Promise<void> {
  await writeJson(`/api/v1/exports/${encodeURIComponent(input.exportId)}/retry`, input.csrfToken, {});
}

export async function attachFeishuResult(input: {
  exportId: string;
  csrfToken: string;
  documentId: string;
  documentUrl: string;
}): Promise<void> {
  await writeJson(`/api/v1/exports/${encodeURIComponent(input.exportId)}/feishu/attach`, input.csrfToken, {
    schemaVersion: 1,
    documentId: input.documentId,
    documentUrl: input.documentUrl,
  });
}

export async function listRevisions(renditionId: string): Promise<RevisionList> {
  const response = await fetch(
    `/api/v1/renditions/${encodeURIComponent(renditionId)}/revisions?limit=100`,
    { credentials: "same-origin" },
  );
  return (await parseResponse(response, ApiSuccessSchema(RevisionListSchema))).data;
}

export async function uploadProjectBundle(input: {
  file: File;
  csrfToken: string;
}): Promise<string> {
  const chunkSize = 6 * 1024 * 1024;
  const chunkCount = Math.max(1, Math.ceil(input.file.size / chunkSize));
  let fileId: string | null = null;
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = input.file.slice(index * chunkSize, Math.min(input.file.size, (index + 1) * chunkSize));
    const digest = await crypto.subtle.digest("SHA-256", await chunk.arrayBuffer());
    const chunkSha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const form = new FormData();
    if (fileId === null) {
      form.append("relativePath", input.file.name);
      form.append("declaredBytes", String(input.file.size));
    } else {
      form.append("fileId", fileId);
    }
    form.append("chunkIndex", String(index));
    form.append("chunkCount", String(chunkCount));
    form.append("chunkSha256", chunkSha256);
    form.append("file", chunk, `${input.file.name}.part${index}`);
    const response = await fetch("/api/v1/uploads", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "x-csrf-token": input.csrfToken,
        "idempotency-key": crypto.randomUUID(),
      },
      body: form,
    });
    const data = (await parseResponse(response, ApiSuccessSchema(UploadChunkResultSchema))).data;
    fileId = data.fileId;
  }
  if (fileId === null) throw new Error("项目包上传未完成");
  return fileId;
}

export async function importProjectBundle(input: {
  file: File;
  csrfToken: string;
  title?: string;
}): Promise<ProjectBundleImportRecord> {
  const fileId = await uploadProjectBundle({ file: input.file, csrfToken: input.csrfToken });
  const start = await writeJson<{ importId: string; jobId: string }>(
    "/api/v1/project-bundles/imports",
    input.csrfToken,
    {
      schemaVersion: 1,
      fileId,
      ...(input.title === undefined ? {} : { title: input.title }),
    },
  );
  return waitBundleImport(start.importId);
}

export async function getBundleImport(importId: string): Promise<ProjectBundleImportRecord> {
  const response = await fetch(
    `/api/v1/project-bundles/imports/${encodeURIComponent(importId)}`,
    { credentials: "same-origin" },
  );
  return (await parseResponse(response, ApiSuccessSchema(ProjectBundleImportRecordSchema))).data;
}

async function waitBundleImport(importId: string): Promise<ProjectBundleImportRecord> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await getBundleImport(importId);
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("项目包导入仍在后台执行，请稍后查看任务");
}

export async function startFeishuPull(input: {
  bindingId: string;
  expectedLocalRevisionId: string;
  csrfToken: string;
}): Promise<{ pullId: string; jobId: string }> {
  return writeJson<{ pullId: string; jobId: string }>(
    `/api/v1/feishu-bindings/${encodeURIComponent(input.bindingId)}/pull`,
    input.csrfToken,
    { schemaVersion: 1, expectedLocalRevisionId: input.expectedLocalRevisionId },
  );
}

export async function getPull(pullId: string): Promise<PullRecord> {
  const response = await fetch(`/api/v1/pulls/${encodeURIComponent(pullId)}`, {
    credentials: "same-origin",
  });
  return (await parseResponse(response, ApiSuccessSchema(PullRecordSchema))).data;
}

export async function waitPull(pullId: string): Promise<PullRecord> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const pull = await getPull(pullId);
      if (pull.status !== "queued") return pull;
    } catch {
      // The pull row exists only after worker readback; keep polling briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("飞书取回仍在执行，请稍后查看任务");
}

export async function acceptPull(input: {
  pullId: string;
  expectedLocalRevisionId: string;
  label: string;
  csrfToken: string;
}): Promise<PullRecord> {
  return writeJson<PullRecord>(
    `/api/v1/pulls/${encodeURIComponent(input.pullId)}/accept`,
    input.csrfToken,
    {
      schemaVersion: 1,
      expectedLocalRevisionId: input.expectedLocalRevisionId,
      label: input.label,
    },
  );
}

export async function rejectPull(input: { pullId: string; csrfToken: string }): Promise<PullRecord> {
  return writeJson<PullRecord>(
    `/api/v1/pulls/${encodeURIComponent(input.pullId)}/reject`,
    input.csrfToken,
    {},
  );
}

async function writeJson<T>(
  url: string,
  csrfToken: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const parsed = await parseResponse(
    response,
    z.strictObject({ data: z.unknown(), requestId: z.string() }),
  );
  return parsed.data as T;
}
