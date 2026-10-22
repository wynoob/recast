import { z } from "zod";
import {
  AcceptCandidateResultSchema,
  ApiSuccessSchema,
  BriefInputSchema,
  CandidateViewSchema,
  ConfirmationViewSchema,
  ContentDetailSchema,
  DeriveRenditionResultSchema,
  EvidenceSelectRequestSchema,
  FixedEvidenceSchema,
  GenerationInputViewSchema,
  JobSnapshotSchema,
  ManualRevisionRequestSchema,
  MergePreviewSchema,
  MessageViewSchema,
  ProviderConfigInputSchema,
  ProviderConfigViewSchema,
  RevisionListSchema,
  RevisionViewSchema,
  type AcceptCandidateResult,
  type BriefInput,
  type CandidateDecision,
  type CandidateView,
  type CreateMessageRequest,
  type CreateGenerationInputRequest,
  type ContentDetail,
  type DeriveRenditionResult,
  type FixedEvidence,
  type GenerationInputView,
  type JobSnapshot,
  type ManualRevisionRequest,
  type MergePreview,
  type MessageView,
  type ProviderConfigInput,
  type ProviderConfigView,
  type RevisionList,
  type RevisionView,
} from "@dmall/contracts";
import { parseResponse } from "../api.js";

const MessageListSchema = z.strictObject({ items: z.array(MessageViewSchema) });
const PlanResponseSchema = z.strictObject({
  confirmation: ConfirmationViewSchema.nullable(),
  current: z.boolean(),
  messages: z.array(MessageViewSchema),
});
export type PlanResponse = z.infer<typeof PlanResponseSchema>;
const EvidenceListSchema = z.strictObject({ items: z.array(FixedEvidenceSchema) });
const MessageCreateResponseSchema = z.strictObject({
  message: MessageViewSchema,
  providerRun: z.string(),
});
const LocalGenerationResponseSchema = z.strictObject({
  candidate: CandidateViewSchema,
  warnings: z.array(z.string()),
});
const ProviderListSchema = z.strictObject({ items: z.array(ProviderConfigViewSchema) });

export type AuthoringMessage = MessageView;
export type AuthoringEvidence = FixedEvidence;

export function messagesQuery(contentId: string) {
  return {
    queryKey: ["authoring", contentId, "messages"] as const,
    queryFn: async (): Promise<MessageView[]> =>
      (await get(`/api/v1/contents/${contentId}/messages`, MessageListSchema)).items,
  };
}

export function planQuery(contentId: string) {
  return {
    queryKey: ["authoring", contentId, "plan"] as const,
    queryFn: async () =>
      get(`/api/v1/contents/${contentId}/plan`, PlanResponseSchema),
  };
}

export function evidenceQuery(contentId: string) {
  return {
    queryKey: ["authoring", contentId, "evidence"] as const,
    queryFn: async (): Promise<FixedEvidence[]> =>
      (await get(`/api/v1/contents/${contentId}/evidence`, EvidenceListSchema)).items,
  };
}

export function providersQuery() {
  return {
    queryKey: ["authoring", "providers"] as const,
    queryFn: async (): Promise<ProviderConfigView[]> =>
      (await get("/api/v1/settings/providers", ProviderListSchema)).items,
  };
}

export function revisionsQuery(renditionId: string) {
  return {
    queryKey: ["rendition", renditionId, "revisions"] as const,
    queryFn: async (): Promise<RevisionList> =>
      get(`/api/v1/renditions/${renditionId}/revisions?limit=100`, RevisionListSchema),
  };
}

export function revisionQuery(renditionId: string, revisionId: string) {
  return {
    queryKey: ["rendition", renditionId, "revision", revisionId] as const,
    queryFn: async (): Promise<RevisionView> =>
      get(
        `/api/v1/renditions/${renditionId}/revisions?revisionId=${revisionId}`,
        RevisionViewSchema,
      ),
  };
}

export async function getRevision(renditionId: string, revisionId: string): Promise<RevisionView> {
  return get(
    `/api/v1/renditions/${renditionId}/revisions?revisionId=${revisionId}`,
    RevisionViewSchema,
  );
}

export async function appendMessage(input: {
  contentId: string;
  csrfToken: string;
  request: CreateMessageRequest;
}): Promise<{ message: MessageView; providerRun: string }> {
  return write(
    "POST",
    `/api/v1/contents/${input.contentId}/messages`,
    input.csrfToken,
    input.request,
    MessageCreateResponseSchema,
  );
}

export async function confirmPlan(input: {
  contentId: string;
  csrfToken: string;
  expectedVersion: number;
  brief: BriefInput;
  outline: Array<{ id: string; title: string }>;
  renditionId: string | null;
  questionDecisions?: Array<{
    index: number;
    originalText: string;
    action: "keep_blocking" | "continue_with_gap";
    messageId?: string;
  }>;
}): Promise<z.infer<typeof PlanResponseSchema>> {
  const decisions = input.questionDecisions ?? input.brief.unresolvedQuestions.map((originalText, index) => ({
    index,
    originalText,
    action: "keep_blocking" as const,
  }));
  return write(
    "POST",
    `/api/v1/contents/${input.contentId}/plan/confirm`,
    input.csrfToken,
    {
      schemaVersion: 1,
      expectedVersion: input.expectedVersion,
      brief: input.brief,
      outline: input.outline,
      questionDecisions: decisions,
      confirmationText: `确认需求与 ${input.outline.length} 个章节`,
      renditionId: input.renditionId,
    },
    PlanResponseSchema,
  );
}

export async function selectEvidence(input: {
  contentId: string;
  csrfToken: string;
  handles: string[];
}): Promise<FixedEvidence[]> {
  return (await write(
    "POST",
    `/api/v1/contents/${input.contentId}/evidence/select`,
    input.csrfToken,
    EvidenceSelectRequestSchema.parse({
      schemaVersion: 1,
      selectionHandles: input.handles,
    }),
    EvidenceListSchema,
  )).items;
}

export async function createGenerationInput(input: {
  contentId: string;
  renditionId: string;
  csrfToken: string;
  request: CreateGenerationInputRequest;
}): Promise<GenerationInputView> {
  return write(
    "POST",
    `/api/v1/renditions/${input.renditionId}/generation-inputs`,
    input.csrfToken,
    { ...input.request, contentId: input.contentId },
    GenerationInputViewSchema,
  );
}

export async function generateLocalDraft(input: {
  contentId: string;
  renditionId: string;
  inputId: string;
  csrfToken: string;
}): Promise<{ candidate: CandidateView; warnings: string[] }> {
  return write(
    "POST",
    `/api/v1/renditions/${input.renditionId}/local-generation`,
    input.csrfToken,
    { schemaVersion: 1, contentId: input.contentId, inputId: input.inputId },
    LocalGenerationResponseSchema,
  );
}

export async function generateWithProvider(input: {
  inputId: string;
  csrfToken: string;
}): Promise<JobSnapshot> {
  return write(
    "POST",
    `/api/v1/generation-inputs/${input.inputId}/generate`,
    input.csrfToken,
    { schemaVersion: 1, task: "generate" },
    JobSnapshotSchema,
  );
}

export async function transcribeAudio(input: {
  contentId: string;
  renditionId: string | null;
  csrfToken: string;
  audioBase64: string;
  mimeType: string;
  language: string;
}): Promise<JobSnapshot> {
  return write(
    "POST",
    `/api/v1/contents/${input.contentId}/transcribe`,
    input.csrfToken,
    {
      schemaVersion: 1,
      renditionId: input.renditionId,
      audioBase64: input.audioBase64,
      mimeType: input.mimeType,
      language: input.language,
    },
    JobSnapshotSchema,
  );
}

export async function retryProviderAttempt(input: {
  jobId: string;
  csrfToken: string;
  expectedInputHash: string;
}): Promise<JobSnapshot> {
  return write(
    "POST",
    `/api/v1/jobs/${input.jobId}/provider-resume`,
    input.csrfToken,
    {
      schemaVersion: 1,
      decision: "explicit_retry_new_attempt",
      expectedInputHash: input.expectedInputHash,
    },
    JobSnapshotSchema,
  );
}

export async function createCandidate(input: {
  renditionId: string;
  csrfToken: string;
  body: {
    schemaVersion: 1;
    inputId: string;
    expectedRevisionId: string;
    operations: unknown[];
    claims?: unknown[];
    modelRunId?: string | null;
  };
}): Promise<CandidateView> {
  return write(
    "POST",
    `/api/v1/renditions/${input.renditionId}/candidates`,
    input.csrfToken,
    input.body,
    CandidateViewSchema,
  );
}

export function candidatePreviewQuery(candidateId: string) {
  return {
    queryKey: ["candidate", candidateId, "preview"] as const,
    queryFn: async (): Promise<MergePreview> =>
      (await get(`/api/v1/candidates/${candidateId}/preview`, ApiSuccessSchema(MergePreviewSchema))).data,
  };
}

export async function acceptCandidate(input: {
  candidateId: string;
  csrfToken: string;
  expectedRevisionId: string;
  previewToken: string;
  decisions: CandidateDecision[];
  frozenPlanAcknowledgement?: {
    confirmationId: string;
    contentVersion: number;
    planHash: string;
    messageId: string;
  } | null;
}): Promise<AcceptCandidateResult> {
  return write(
    "POST",
    `/api/v1/candidates/${input.candidateId}/accept`,
    input.csrfToken,
    {
      schemaVersion: 1,
      expectedRevisionId: input.expectedRevisionId,
      previewToken: input.previewToken,
      decisions: input.decisions,
      frozenPlanAcknowledgement: input.frozenPlanAcknowledgement ?? null,
    },
    AcceptCandidateResultSchema,
  );
}

export async function rejectCandidate(input: {
  candidateId: string;
  csrfToken: string;
  expectedRevisionId: string;
}): Promise<CandidateView> {
  return write(
    "POST",
    `/api/v1/candidates/${input.candidateId}/reject`,
    input.csrfToken,
    { schemaVersion: 1, expectedRevisionId: input.expectedRevisionId, reason: "用户拒绝候选" },
    CandidateViewSchema,
  );
}

export async function saveRevision(input: {
  renditionId: string;
  csrfToken: string;
  request: ManualRevisionRequest;
}): Promise<RevisionView> {
  return write(
    "POST",
    `/api/v1/renditions/${input.renditionId}/revisions`,
    input.csrfToken,
    ManualRevisionRequestSchema.parse(input.request),
    RevisionViewSchema,
  );
}

export async function restoreRevision(input: {
  renditionId: string;
  csrfToken: string;
  historicalRevisionId: string;
  expectedRevisionId: string;
}): Promise<RevisionView> {
  return write(
    "POST",
    `/api/v1/renditions/${input.renditionId}/restore`,
    input.csrfToken,
    {
      schemaVersion: 1,
      historicalRevisionId: input.historicalRevisionId,
      expectedRevisionId: input.expectedRevisionId,
    },
    RevisionViewSchema,
  );
}

export async function deriveRendition(input: {
  contentId: string;
  csrfToken: string;
  fromRevisionId: string;
  targetKind: "feishu_doc" | "html_deck";
  label: string;
  confirmationId: string | null;
}): Promise<DeriveRenditionResult> {
  return write(
    "POST",
    `/api/v1/contents/${input.contentId}/derive`,
    input.csrfToken,
    {
      schemaVersion: 1,
      fromRevisionId: input.fromRevisionId,
      targetKind: input.targetKind,
      label: input.label,
      confirmationId: input.confirmationId,
    },
    DeriveRenditionResultSchema,
  );
}

export async function saveProviderConfig(input: {
  csrfToken: string;
  request: ProviderConfigInput;
}): Promise<ProviderConfigView> {
  const result = await write(
    "PUT",
    "/api/v1/settings/providers",
    input.csrfToken,
    ProviderConfigInputSchema.parse(input.request),
    z.strictObject({ item: ProviderConfigViewSchema }),
  );
  return result.item;
}

export async function probeTextProvider(input: {
  csrfToken: string;
}): Promise<JobSnapshot> {
  return write(
    "POST",
    "/api/v1/settings/providers/text/probe",
    input.csrfToken,
    { schemaVersion: 1, role: "text" },
    JobSnapshotSchema,
  );
}

export async function updateTitle(input: {
  contentId: string;
  csrfToken: string;
  title: string;
  expectedVersion: number;
}): Promise<ContentDetail> {
  return write(
    "PATCH",
    `/api/v1/contents/${input.contentId}`,
    input.csrfToken,
    { schemaVersion: 1, title: input.title, expectedVersion: input.expectedVersion },
    ContentDetailSchema,
  );
}

async function get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  return (await parseResponse(response, ApiSuccessSchema(schema))).data;
}

async function write<T>(
  method: "POST" | "PUT" | "PATCH",
  url: string,
  csrfToken: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(url, {
    method,
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

export function briefFromContent(content: ContentDetail): BriefInput {
  return BriefInputSchema.parse({
    goal: content.brief.goal,
    audience: content.brief.audience,
    merchantId: content.brief.merchantId,
    durationMinutes: content.brief.durationMinutes,
    userOutline: content.brief.userOutline,
    mustKeepOutline: content.brief.mustKeepOutline,
    tone: content.brief.tone,
    sourceScope: content.brief.sourceScope,
    unresolvedQuestions: content.brief.unresolvedQuestions,
  });
}
