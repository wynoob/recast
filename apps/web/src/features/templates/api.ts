import {
  ApiSuccessSchema,
  JobSnapshotSchema,
  TemplateDetailSchema,
  TemplateListSchema,
  ValidateTemplateJobSchema,
  type ContentKind,
  type JobSnapshot,
  type NarrativeId,
  type TemplateDetail,
  type TemplateList,
  type TemplatePackage,
} from "@dmall/contracts";
import type { ZodType } from "zod";
import { parseResponse } from "../../api.js";

interface TemplateFilters {
  q?: string;
  kind?: ContentKind;
  status?: "draft" | "ready" | "archived";
}

export function templateListQuery(filters: TemplateFilters) {
  const params = new URLSearchParams({ limit: "100" });
  if (filters.q !== undefined && filters.q.trim() !== "") params.set("q", filters.q.trim());
  if (filters.kind !== undefined) params.set("kind", filters.kind);
  if (filters.status !== undefined) params.set("status", filters.status);
  return {
    queryKey: ["templates", filters] as const,
    queryFn: async (): Promise<TemplateList> => {
      const response = await fetch(`/api/v1/templates?${params.toString()}`, {
        credentials: "same-origin",
      });
      return (await parseResponse(response, ApiSuccessSchema(TemplateListSchema))).data;
    },
  };
}

export function templateDetailQuery(id: string, versionId?: string) {
  const params = versionId === undefined ? "" : `?versionId=${encodeURIComponent(versionId)}`;
  return {
    queryKey: ["template", id, versionId ?? "latest"] as const,
    queryFn: async (): Promise<TemplateDetail> => {
      const response = await fetch(`/api/v1/templates/${encodeURIComponent(id)}${params}`, {
        credentials: "same-origin",
      });
      return (await parseResponse(response, ApiSuccessSchema(TemplateDetailSchema))).data;
    },
  };
}

export async function createTemplate(input: {
  name: string;
  kind: ContentKind;
  narrativeId: NarrativeId;
  csrfToken: string;
}): Promise<TemplateDetail> {
  return write<TemplateDetail>("/api/v1/templates", input.csrfToken, {
    schemaVersion: 1,
    name: input.name,
    kind: input.kind,
    narrativeId: input.narrativeId,
  }, TemplateDetailSchema);
}

export async function createTemplateVersion(input: {
  templateId: string;
  baseVersionId: string;
  packageValue: TemplatePackage;
  changeSummary: string;
  csrfToken: string;
}): Promise<TemplateDetail> {
  return write<TemplateDetail>(
    `/api/v1/templates/${encodeURIComponent(input.templateId)}/versions`,
    input.csrfToken,
    {
      schemaVersion: 1,
      baseVersionId: input.baseVersionId,
      narrative: input.packageValue.narrative,
      layouts: input.packageValue.layouts,
      theme: input.packageValue.theme,
      slots: input.packageValue.slots,
      capabilities: input.packageValue.capabilities,
      changeSummary: input.changeSummary.trim(),
    },
    TemplateDetailSchema,
  );
}

export async function validateTemplateVersion(input: {
  templateId: string;
  versionId: string;
  csrfToken: string;
}): Promise<ReturnType<typeof ValidateTemplateJobSchema.parse>> {
  return write(
    `/api/v1/templates/${encodeURIComponent(input.templateId)}/validate`,
    input.csrfToken,
    { schemaVersion: 1, versionId: input.versionId },
    ValidateTemplateJobSchema,
  );
}

export async function archiveTemplateVersion(input: {
  templateId: string;
  versionId: string;
  expectedStatus: "draft" | "ready";
  csrfToken: string;
}): Promise<TemplateDetail> {
  return write(
    `/api/v1/templates/${encodeURIComponent(input.templateId)}/archive`,
    input.csrfToken,
    {
      schemaVersion: 1,
      versionId: input.versionId,
      expectedStatus: input.expectedStatus,
    },
    TemplateDetailSchema,
  );
}

export async function getJob(jobId: string): Promise<JobSnapshot> {
  const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, {
    credentials: "same-origin",
  });
  return (await parseResponse(response, ApiSuccessSchema(JobSnapshotSchema))).data;
}

async function write<T>(
  url: string,
  csrfToken: string,
  body: unknown,
  schema: ZodType<T>,
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
  return (await parseResponse(response, ApiSuccessSchema(schema))).data;
}
