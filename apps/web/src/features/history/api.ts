import { ApiSuccessSchema, ExportListSchema, RevisionListSchema, RevisionViewSchema } from "@dmall/contracts";
import { parseResponse } from "../../api.js";

export async function historyExports(contentId: string, cursor: string | null) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor !== null) params.set("cursor", cursor);
  const response = await fetch(`/api/v1/contents/${encodeURIComponent(contentId)}/exports?${params}`, { credentials: "same-origin" });
  return (await parseResponse(response, ApiSuccessSchema(ExportListSchema))).data;
}

export async function historyRevisions(renditionId: string, cursor: string | null) {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor !== null) params.set("cursor", cursor);
  const response = await fetch(`/api/v1/renditions/${encodeURIComponent(renditionId)}/revisions?${params}`, { credentials: "same-origin" });
  return (await parseResponse(response, ApiSuccessSchema(RevisionListSchema))).data;
}

export async function historyRevision(renditionId: string, revisionId: string) {
  const response = await fetch(`/api/v1/renditions/${encodeURIComponent(renditionId)}/revisions?revisionId=${encodeURIComponent(revisionId)}`, { credentials: "same-origin" });
  return (await parseResponse(response, ApiSuccessSchema(RevisionViewSchema))).data;
}
