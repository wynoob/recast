import { z } from "zod";
import {
  AstSchema,
  EditOperationSchema,
  RevisionCreatedBySchema,
  RevisionRecordSchema,
} from "./ast.js";
import { FactEntitySchema } from "./facts.js";
import { TemplatePackageSchema } from "./templates.js";
import {
  HashSchema,
  NodeIdSchema,
  SchemaVersionSchema,
  SelectionHandleSchema as RootSelectionHandleSchema,
  TemplateVersionIdSchema,
  UtcTimeSchema,
  UuidSchema,
} from "./ids.js";
import { SourceLocatorSchema } from "./locators.js";
import {
  BriefInputSchema,
  BriefSchema,
  ContentDetailSchema,
} from "./api.js";

export const RevisionRefTypeSchema = z.enum([
  "source_version",
  "fact_version",
  "message",
  "asset_version",
  "occurrence",
  "derivative",
  "segment",
  "template_version",
]);
export type RevisionRefType = z.infer<typeof RevisionRefTypeSchema>;

export const RevisionRefSchema = z.strictObject({
  refType: RevisionRefTypeSchema,
  refId: UuidSchema,
});
export type RevisionRef = z.infer<typeof RevisionRefSchema>;

export const ClaimSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fact"),
    nodeId: NodeIdSchema,
    textHash: HashSchema,
    factEvidenceId: UuidSchema,
  }),
  z.strictObject({
    kind: z.literal("source_interpretation"),
    nodeId: NodeIdSchema,
    textHash: HashSchema,
    evidenceIds: z.array(UuidSchema).min(1),
    review: z.literal("requires_human"),
  }),
  z.strictObject({
    kind: z.literal("user_assertion"),
    nodeId: NodeIdSchema,
    textHash: HashSchema,
    evidenceId: UuidSchema,
  }),
  z.strictObject({
    kind: z.literal("gap"),
    nodeId: NodeIdSchema,
    question: z.string(),
  }),
]);
export type Claim = z.infer<typeof ClaimSchema>;

export const AuthoringOperationSchema = EditOperationSchema;
export type AuthoringOperation = z.infer<typeof AuthoringOperationSchema>;

export const ManualRevisionRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  baseRevisionId: UuidSchema,
  operations: z.array(AuthoringOperationSchema),
  claims: z.array(ClaimSchema).default([]),
  evidenceSelections: z.array(UuidSchema).default([]),
});
export type ManualRevisionRequest = z.infer<typeof ManualRevisionRequestSchema>;

export const RestoreRevisionRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  historicalRevisionId: UuidSchema,
  expectedRevisionId: UuidSchema,
});
export type RestoreRevisionRequest = z.infer<typeof RestoreRevisionRequestSchema>;

export const OccurrenceBindingSchema = z.strictObject({
  requestedOccurrenceId: UuidSchema,
  canonicalOccurrenceId: UuidSchema,
  observedVersion: z.int().nonnegative(),
  sourceVersionId: UuidSchema,
  locator: SourceLocatorSchema,
  assetIdAtCapture: UuidSchema.nullable(),
  relationHash: HashSchema,
  factEntityHash: HashSchema.nullable().optional(),
  indexTextHash: HashSchema.nullable().optional(),
  modelClaimMap: z.record(z.string(), z.string()).optional(),
  bindingHash: HashSchema.optional(),
});
export type OccurrenceBinding = z.infer<typeof OccurrenceBindingSchema>;

export const RevisionEvidenceSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  directRefs: z.array(RevisionRefSchema),
  transitiveRefs: z.array(RevisionRefSchema),
  blobHashes: z.array(HashSchema),
  bindings: z.array(OccurrenceBindingSchema),
  bindingHash: HashSchema,
});
export type RevisionEvidence = z.infer<typeof RevisionEvidenceSchema>;

export const RefStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("available"), checkedAt: UtcTimeSchema }),
  z.strictObject({ kind: z.literal("missing"), reason: z.string() }),
  z.strictObject({ kind: z.literal("unresolved_history"), reason: z.string() }),
]);
export type RefState = z.infer<typeof RefStateSchema>;

export const RevisionViewSchema = RevisionRecordSchema.extend({
  evidenceHash: HashSchema.nullable(),
  evidence: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("resolved"), evidence: RevisionEvidenceSchema }),
    z.strictObject({ kind: z.literal("unresolved"), reason: z.literal("REFERENCE_HISTORY_UNRESOLVED") }),
    z.strictObject({ kind: z.literal("empty"), evidence: RevisionEvidenceSchema }),
  ]),
  references: z.array(
    z.strictObject({
      ref: RevisionRefSchema,
      state: RefStateSchema,
    }),
  ),
});
export type RevisionView = z.infer<typeof RevisionViewSchema>;

export const RevisionListItemSchema = z.strictObject({
  id: UuidSchema,
  renditionId: UuidSchema,
  parentId: UuidSchema.nullable(),
  templateVersionId: TemplateVersionIdSchema.nullable(),
  createdBy: RevisionCreatedBySchema,
  reason: z.string(),
  createdAt: UtcTimeSchema,
  evidenceHash: HashSchema.nullable(),
  evidenceState: z.enum(["resolved", "unresolved", "empty"]),
});
export type RevisionListItem = z.infer<typeof RevisionListItemSchema>;

export const RevisionListSchema = z.strictObject({
  items: z.array(RevisionListItemSchema),
  nextCursor: z.string().nullable(),
  total: z.int().nonnegative(),
});
export type RevisionList = z.infer<typeof RevisionListSchema>;

export const RevisionQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  revisionId: UuidSchema.optional(),
});
export type RevisionQuery = z.infer<typeof RevisionQuerySchema>;

export function parseManualRevisionRequest(input: unknown): ManualRevisionRequest {
  return ManualRevisionRequestSchema.parse(input);
}

export function parseRestoreRevisionRequest(input: unknown): RestoreRevisionRequest {
  return RestoreRevisionRequestSchema.parse(input);
}

export function parseRevisionQuery(input: unknown): RevisionQuery {
  return RevisionQuerySchema.parse(input);
}

export function parseRevisionAst(input: unknown) {
  return AstSchema.parse(input);
}

const HashStringSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const IndexTextSchema = z.strictObject({
  text: z.string().min(1),
  codePoints: z.int().positive(),
  textHash: HashStringSchema,
});
export type IndexText = z.infer<typeof IndexTextSchema>;

export const ChunkEntitySchema = z.strictObject({
  chunkId: UuidSchema,
  refType: z.literal("chunk"),
  refId: UuidSchema,
  sourceVersionId: UuidSchema,
  occurrenceId: UuidSchema.nullable(),
  blockIds: z.array(UuidSchema),
  locators: z.array(SourceLocatorSchema),
  fullText: z.string(),
  indexText: IndexTextSchema,
});
export type ChunkEntity = z.infer<typeof ChunkEntitySchema>;

export const FactEvidenceEntitySchema = z.strictObject({
  factId: UuidSchema,
  factVersionId: UuidSchema,
  statement: z.string().min(1),
  value: z.union([z.number().finite(), z.string()]),
  unit: z.string().min(1),
  period: z.unknown().nullable(),
  merchantId: UuidSchema.nullable(),
  factKind: z.enum(["measured", "estimated", "user_assertion"]),
  sourceVersionIds: z.array(UuidSchema),
  sourceLocators: z.array(SourceLocatorSchema),
  indexText: IndexTextSchema,
  entityHash: HashStringSchema,
  indexTextHash: HashStringSchema,
  sourceEntity: FactEntitySchema,
});
export type FactEvidenceEntity = z.infer<typeof FactEvidenceEntitySchema>;

export const FixedEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("source"),
    evidenceId: UuidSchema,
    selectionHandle: RootSelectionHandleSchema,
    indexGenerationId: UuidSchema,
    refType: z.literal("chunk"),
    refId: UuidSchema,
    sourceVersionId: UuidSchema,
    occurrence: OccurrenceBindingSchema.nullable(),
    chunks: z.array(ChunkEntitySchema).min(1),
    exactText: z.string(),
    entityHash: HashStringSchema,
    indexTextHash: HashStringSchema,
  }),
  z.strictObject({
    kind: z.literal("fact"),
    evidenceId: UuidSchema,
    selectionHandle: RootSelectionHandleSchema,
    indexGenerationId: UuidSchema,
    entity: FactEvidenceEntitySchema,
    source: z.array(UuidSchema),
    entityHash: HashStringSchema,
    indexTextHash: HashStringSchema,
  }),
  z.strictObject({
    kind: z.literal("media"),
    evidenceId: UuidSchema,
    selectionHandle: RootSelectionHandleSchema.nullable(),
    assetVersionId: UuidSchema,
    assetId: UuidSchema,
    mediaKind: z.enum(["image", "gif", "video"]),
    blobHash: HashStringSchema,
    occurrence: OccurrenceBindingSchema.nullable(),
    derivative: z.strictObject({
      id: UuidSchema,
      blobHash: HashStringSchema,
      recipeHash: HashStringSchema,
    }).nullable(),
    segment: z.strictObject({
      id: UuidSchema,
      startMs: z.int().nonnegative(),
      endMs: z.int().positive(),
    }).nullable(),
    poster: z.strictObject({
      id: UuidSchema,
      blobHash: HashStringSchema,
    }).nullable(),
  }),
  z.strictObject({
    kind: z.literal("user_assertion"),
    evidenceId: UuidSchema,
    selectionHandle: RootSelectionHandleSchema.nullable(),
    messageId: UuidSchema,
    contentId: UuidSchema,
    exactText: z.string(),
    textHash: HashStringSchema,
  }),
]);
export type FixedEvidence = z.infer<typeof FixedEvidenceSchema>;

export const EvidenceSelectRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  selectionHandles: z.array(RootSelectionHandleSchema).max(50),
  occurrenceId: UuidSchema.nullable().optional(),
});
export type EvidenceSelectRequest = z.infer<typeof EvidenceSelectRequestSchema>;

export const MessageModeSchema = z.enum(["plan", "revise", "note", "confirm_outline"]);
export type MessageMode = z.infer<typeof MessageModeSchema>;

export const MessageViewSchema = z.strictObject({
  id: UuidSchema,
  conversationId: UuidSchema,
  renditionId: UuidSchema.nullable(),
  role: z.enum(["system", "user", "assistant"]),
  text: z.string(),
  mode: z.enum(["plan", "revise", "note", "confirm_outline", "historical"]),
  targetNodeIds: z.array(UuidSchema),
  candidateId: UuidSchema.nullable(),
  jobId: UuidSchema.nullable(),
  planId: z.string().nullable(),
  transcriptId: z.string().nullable(),
  createdAt: UtcTimeSchema,
});
export type MessageView = z.infer<typeof MessageViewSchema>;

export const CreateMessageRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  mode: MessageModeSchema.exclude(["confirm_outline"]),
  text: z.string().trim().min(1).max(20_000),
  renditionId: UuidSchema.nullable(),
  targetNodeIds: z.array(UuidSchema).default([]),
});
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;

export const QuestionDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    index: z.int().nonnegative(),
    originalText: z.string(),
    action: z.literal("keep_blocking"),
  }),
  z.strictObject({
    index: z.int().nonnegative(),
    originalText: z.string(),
    action: z.literal("continue_with_gap"),
    messageId: UuidSchema,
  }),
]);
export type QuestionDecision = z.infer<typeof QuestionDecisionSchema>;

export const ConfirmationViewSchema = z.strictObject({
  confirmationId: UuidSchema,
  contentId: UuidSchema,
  contentVersion: z.int().nonnegative(),
  brief: z.lazy(() => BriefSchema),
  outline: z.array(z.strictObject({ id: NodeIdSchema, title: z.string() })),
  questionDecisions: z.array(QuestionDecisionSchema),
  confirmedByMessageId: UuidSchema,
  planHash: HashStringSchema,
  createdAt: UtcTimeSchema,
});
export type ConfirmationView = z.infer<typeof ConfirmationViewSchema>;

export const ConfirmPlanRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedVersion: z.int().nonnegative(),
  brief: z.lazy(() => BriefInputSchema),
  outline: z.array(z.strictObject({ id: NodeIdSchema, title: z.string().trim().min(1) })).min(1),
  questionDecisions: z.array(QuestionDecisionSchema).default([]),
  confirmationText: z.string().trim().min(1).max(4_000),
  renditionId: UuidSchema.nullable(),
});
export type ConfirmPlanRequest = z.infer<typeof ConfirmPlanRequestSchema>;

export const PlanViewSchema = z.strictObject({
  confirmation: ConfirmationViewSchema,
  current: z.boolean(),
  messages: z.array(MessageViewSchema),
});
export type PlanView = z.infer<typeof PlanViewSchema>;

export const GenerationInputViewSchema = z.strictObject({
  id: UuidSchema,
  contentId: UuidSchema,
  renditionId: UuidSchema,
  baseRevisionId: UuidSchema,
  rootNodeId: UuidSchema,
  confirmationId: UuidSchema,
  targetKind: z.enum(["feishu_doc", "html_deck"]),
  targetNodeIds: z.array(UuidSchema),
  templateVersionId: UuidSchema,
  templateHash: HashStringSchema,
  templatePackage: TemplatePackageSchema,
  evidence: z.array(FixedEvidenceSchema),
  unplacedOwnerMap: z.record(z.string(), UuidSchema),
  providerConfigVersion: z.string(),
  promptVersion: z.string(),
  schemaVersion: z.literal(1),
  compositionSnapshotHash: HashSchema.nullable().default(null),
  inputHash: HashStringSchema,
  createdAt: UtcTimeSchema,
});
export type GenerationInputView = z.infer<typeof GenerationInputViewSchema>;

export const CreateGenerationInputRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  baseRevisionId: UuidSchema,
  confirmationId: UuidSchema,
  templateVersionId: UuidSchema,
  selectedEvidenceIds: z.array(UuidSchema).default([]),
  targetNodeIds: z.array(UuidSchema),
  unplacedOwnerMap: z.record(z.string(), UuidSchema).default({}),
});
export type CreateGenerationInputRequest = z.infer<typeof CreateGenerationInputRequestSchema>;

export const CandidateStatusSchema = z.enum(["pending", "accepted", "rejected", "conflicted"]);
export const CandidateViewSchema = z.strictObject({
  id: UuidSchema,
  renditionId: UuidSchema,
  baseRevisionId: UuidSchema,
  inputId: UuidSchema,
  confirmationId: UuidSchema,
  templateVersionId: UuidSchema,
  operations: z.array(AuthoringOperationSchema),
  claims: z.array(ClaimSchema),
  payloadHash: HashStringSchema,
  status: CandidateStatusSchema,
  modelRunId: z.string().nullable(),
  appliedRevisionId: UuidSchema.nullable(),
  acceptanceHash: z.string().nullable(),
  acceptedDecisions: z.array(z.unknown()).nullable(),
  acceptedAt: UtcTimeSchema.nullable(),
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type CandidateView = z.infer<typeof CandidateViewSchema>;

export const ChangeGroupViewSchema = z.strictObject({
  groupId: z.string().regex(/^g1:[a-f0-9]{64}$/),
  classification: z.enum(["automatic", "satisfied", "conflict", "blocked"]),
  kind: z.enum(["field", "insert", "remove", "move", "mixed"]),
  nodeIds: z.array(NodeIdSchema),
  anchors: z.array(NodeIdSchema),
  semanticTags: z.array(z.string()),
  operationIndexes: z.array(z.int().nonnegative()).min(1),
  baseValue: z.unknown(),
  currentValue: z.unknown(),
  candidateValue: z.unknown(),
  reason: z.string().nullable(),
});
export type ChangeGroupView = z.infer<typeof ChangeGroupViewSchema>;

export const PreviewBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithmVersion: z.literal("t06-merge/1"),
  candidateId: UuidSchema,
  payloadHash: HashStringSchema,
  baseRevisionId: UuidSchema,
  currentRevisionId: UuidSchema,
  templateVersionId: UuidSchema,
  templateRulesHash: HashStringSchema,
  evidenceRelationHash: HashStringSchema,
  evidenceAvailabilityHash: HashStringSchema,
  groupIds: z.array(z.string()),
  automaticOperationIndexes: z.array(z.int().nonnegative()),
  conflictGroupIds: z.array(z.string()),
  blockedGroupIds: z.array(z.string()),
});
export type PreviewBinding = z.infer<typeof PreviewBindingSchema>;

export const MergePreviewSchema = z.strictObject({
  candidateId: UuidSchema,
  baseRevisionId: UuidSchema,
  currentRevisionId: UuidSchema,
  baseAst: AstSchema,
  currentAst: AstSchema,
  candidateAst: AstSchema,
  resolvedAst: AstSchema.nullable(),
  groups: z.array(ChangeGroupViewSchema),
  automaticGroupIds: z.array(z.string()),
  satisfiedGroupIds: z.array(z.string()),
  conflictGroupIds: z.array(z.string()),
  blockedGroupIds: z.array(z.string()),
  previewToken: z.string().regex(/^pt1:[a-f0-9]{64}$/),
  previewBinding: PreviewBindingSchema,
});
export type MergePreview = z.infer<typeof MergePreviewSchema>;

export const CandidateDecisionSchema = z.strictObject({
  groupId: z.string().regex(/^g1:[a-f0-9]{64}$/),
  choice: z.enum(["keep_current", "accept_candidate"]),
});
export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

export const FrozenPlanAcknowledgementSchema = z.strictObject({
  confirmationId: UuidSchema,
  contentVersion: z.int().nonnegative(),
  planHash: HashStringSchema,
  messageId: UuidSchema,
});
export type FrozenPlanAcknowledgement = z.infer<typeof FrozenPlanAcknowledgementSchema>;

export const AcceptanceBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithmVersion: z.literal("t06-acceptance/1"),
  candidateId: UuidSchema,
  payloadHash: HashStringSchema,
  baseRevisionId: UuidSchema,
  previewCurrentRevisionId: UuidSchema,
  previewToken: z.string().regex(/^pt1:[a-f0-9]{64}$/),
  decisions: z.array(CandidateDecisionSchema),
  frozenPlanAcknowledgement: FrozenPlanAcknowledgementSchema.nullable(),
  templateVersionId: UuidSchema,
  templateRulesHash: HashStringSchema,
  evidenceClosureHash: HashStringSchema,
  appliedBy: z.literal("accept_candidate"),
});
export type AcceptanceBinding = z.infer<typeof AcceptanceBindingSchema>;

export const AcceptCandidateRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedRevisionId: UuidSchema,
  previewToken: z.string().regex(/^pt1:[a-f0-9]{64}$/),
  decisions: z.array(CandidateDecisionSchema).default([]),
  frozenPlanAcknowledgement: FrozenPlanAcknowledgementSchema.nullable().default(null),
});
export type AcceptCandidateRequest = z.infer<typeof AcceptCandidateRequestSchema>;

export const AcceptCandidateResultSchema = z.strictObject({
  candidate: CandidateViewSchema,
  revision: RevisionViewSchema,
  acceptanceHash: z.string().regex(/^ah1:[a-f0-9]{64}$/),
  replayed: z.boolean(),
});
export type AcceptCandidateResult = z.infer<typeof AcceptCandidateResultSchema>;

export const RejectCandidateRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedRevisionId: UuidSchema,
  reason: z.string().trim().max(1_000).default("用户拒绝候选"),
});
export type RejectCandidateRequest = z.infer<typeof RejectCandidateRequestSchema>;

export const CreateCandidateRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  inputId: UuidSchema,
  expectedRevisionId: UuidSchema,
  operations: z.array(AuthoringOperationSchema).min(1),
  claims: z.array(ClaimSchema).default([]),
  modelRunId: z.string().min(1).max(200).nullable().default(null),
});
export type CreateCandidateRequest = z.infer<typeof CreateCandidateRequestSchema>;

export const DeriveRenditionRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  fromRevisionId: UuidSchema,
  targetKind: z.enum(["feishu_doc", "html_deck"]),
  label: z.string().trim().min(1).max(100).default("派生版本"),
  confirmationId: UuidSchema.nullable(),
});
export type DeriveRenditionRequest = z.infer<typeof DeriveRenditionRequestSchema>;

export const DeriveRenditionResultSchema = z.strictObject({
  content: z.lazy(() => ContentDetailSchema),
  renditionId: UuidSchema,
  revisionId: UuidSchema,
});
export type DeriveRenditionResult = z.infer<typeof DeriveRenditionResultSchema>;

export const ReadinessIssueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("duration_required"),
    templateVersionId: UuidSchema,
  }),
  z.strictObject({
    kind: z.literal("unresolved_question"),
    questionIndex: z.int().nonnegative(),
    originalText: z.string(),
  }),
  z.strictObject({
    kind: z.literal("capability"),
    role: z.enum(["text", "embedding", "vision", "asr"]),
    state: z.string(),
  }),
  z.strictObject({
    kind: z.literal("reference"),
    evidenceId: UuidSchema,
    state: z.string(),
  }),
  z.strictObject({
    kind: z.literal("template"),
    templateVersionId: UuidSchema,
    reason: z.string(),
  }),
  z.strictObject({
    kind: z.literal("unplaced_owner_required"),
    blockIds: z.array(UuidSchema),
  }),
]);
export type ReadinessIssue = z.infer<typeof ReadinessIssueSchema>;

export const GenerationReadinessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    kind: z.literal("waiting_input"),
    reasons: z.array(ReadinessIssueSchema).min(1),
  }),
]);
export type GenerationReadiness = z.infer<typeof GenerationReadinessSchema>;

export const ProviderConfigInputSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  role: z.enum(["text", "embedding", "vision", "asr"]),
  baseUrl: z.string().url(),
  modelId: z.string().trim().min(1).max(200),
  keychainRef: z.string().trim().min(1).max(200),
});
export type ProviderConfigInput = z.infer<typeof ProviderConfigInputSchema>;

export const ProviderConfigViewSchema = z.strictObject({
  id: UuidSchema.nullable(),
  role: z.enum(["text", "embedding", "vision", "asr"]),
  baseUrl: z.string().nullable(),
  modelId: z.string().nullable(),
  keychainRef: z.string().nullable(),
  configured: z.boolean(),
  verified: z.boolean(),
  updatedAt: UtcTimeSchema.nullable(),
});
export type ProviderConfigView = z.infer<typeof ProviderConfigViewSchema>;
