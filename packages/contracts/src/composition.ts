import { z } from "zod";
import { HashSchema, SelectionHandleSchema, UuidSchema, UtcTimeSchema } from "./ids.js";
import { ErrorCodeSchema } from "./api.js";
import { FixedEvidenceSchema } from "./authoring.js";
import { ExportArtifactSchema } from "./outputs.js";
import { TemplatePackageSchema } from "./templates.js";

export const DeliveryTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("feishu_doc"), folderToken: z.string().min(1).nullable() }),
  z.strictObject({ kind: z.literal("html_deck") }),
]);
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;
export const ChoicePatchSchema = z.strictObject({
  templateVersionId: UuidSchema.optional(),
  selection: z.strictObject({ includeHandles: z.array(SelectionHandleSchema), excludeEvidenceIds: z.array(UuidSchema) }).optional(),
  crossMerchantUse: z.array(z.strictObject({ merchantId: UuidSchema, purpose: z.enum(["comparison", "reference"]) })).optional(),
});
export type ChoicePatch = z.infer<typeof ChoicePatchSchema>;
export const SubmitCommandSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("create"), idea: z.string().trim().min(1).max(20000), delivery: DeliveryTargetSchema, choices: ChoicePatchSchema.optional() }),
  z.strictObject({ mode: z.literal("adjust"), contentId: UuidSchema, expectedVersion: z.int().nonnegative(), instruction: z.string().trim().min(1).max(20000).optional(), choices: ChoicePatchSchema.optional() })
    .refine((value) => value.instruction !== undefined || (value.choices !== undefined && Object.keys(value.choices).length > 0), "调整必须包含要求或选择"),
]);
export type SubmitCommand = z.infer<typeof SubmitCommandSchema>;
export const ConfirmCommandSchema = z.strictObject({ proposalId: UuidSchema, proposalHash: HashSchema });
export type ConfirmCommand = z.infer<typeof ConfirmCommandSchema>;
export const ResumeCommandSchema = z.strictObject({
  contentId: UuidSchema, expectedExportId: UuidSchema, expectedDecisionVersion: z.int().nonnegative(),
  decision: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("retry_original") }),
    z.strictObject({ kind: z.literal("bind_verified_document"), operationId: UuidSchema, documentId: z.string().min(1), confirmedOriginal: z.literal(true) }),
  ]),
});
export type ResumeCommand = z.infer<typeof ResumeCommandSchema>;
export const CommandIdentitySchema = z.strictObject({ id: UuidSchema, requestHash: HashSchema });
export type CommandIdentity = z.infer<typeof CommandIdentitySchema>;
export const EvidenceSummarySchema = z.strictObject({
  id: UuidSchema, kind: z.enum(["source", "fact", "media", "user_assertion"]), title: z.string(), sourceLabel: z.string(), merchantId: UuidSchema.nullable(), availability: z.enum(["available", "missing"]),
});
export const PlacementSchema = z.strictObject({ evidenceId: UuidSchema, purpose: z.string(), position: z.string(), use: z.enum(["support", "illustration", "comparison", "reference"]) });
export const CompositionGapSchema = z.strictObject({ key: z.string().min(1), question: z.string().min(1), blocksGeneration: z.boolean() });
const section = z.strictObject({ key: z.string().min(1), heading: z.string().min(1), intent: z.string(), templateContainerKey: z.string().min(1), placements: z.array(PlacementSchema) });
const slide = z.strictObject({ key: z.string().min(1), title: z.string().min(1), intent: z.string(), templateContainerKey: z.string().min(1), layoutKey: z.string().min(1), placements: z.array(PlacementSchema.extend({ templateSlotKey: z.string().min(1) })) });
const proposalCommon = {
  id: UuidSchema, contentId: UuidSchema, basedOnVersion: z.int().nonnegative(), hash: HashSchema,
  title: z.string().min(1), purpose: z.string(), audience: z.string(),
  template: z.strictObject({ versionId: UuidSchema, packageHash: HashSchema, reason: z.string().min(1) }),
  evidence: z.array(EvidenceSummarySchema), gaps: z.array(CompositionGapSchema),
};
export const ProposalSchema = z.union([
  z.strictObject({ ...proposalCommon, delivery: z.strictObject({ kind: z.literal("feishu_doc"), folderToken: z.string().min(1).nullable() }), sections: z.array(section).min(1) }),
  z.strictObject({ ...proposalCommon, delivery: z.strictObject({ kind: z.literal("html_deck") }), slides: z.array(slide).min(1) }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;
const partShapes = [
  z.strictObject({ key: z.string().min(1), kind: z.literal("paragraph"), text: z.string().min(1), sources: z.array(UuidSchema) }),
  z.strictObject({ key: z.string().min(1), kind: z.literal("list"), items: z.array(z.string().min(1)).min(1), sources: z.array(UuidSchema) }),
  z.strictObject({ key: z.string().min(1), kind: z.literal("table"), columns: z.array(z.string()).min(1), rows: z.array(z.array(z.string())).min(1), sources: z.array(UuidSchema) }),
  z.strictObject({ key: z.string().min(1), kind: z.literal("image"), evidenceId: UuidSchema, caption: z.string() }),
] as const;
export const BodyPartSchema = z.discriminatedUnion("kind", partShapes);
export type BodyPart = z.infer<typeof BodyPartSchema>;
const deckPart = z.discriminatedUnion("kind", [
  partShapes[0].extend({ templateSlotKey: z.string().min(1) }), partShapes[1].extend({ templateSlotKey: z.string().min(1) }),
  partShapes[2].extend({ templateSlotKey: z.string().min(1) }), partShapes[3].extend({ templateSlotKey: z.string().min(1) }),
]);
export const WholeDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("feishu_doc"), title: z.string().min(1), sections: z.array(z.strictObject({ key: z.string().min(1), heading: z.string().min(1), parts: z.array(BodyPartSchema).min(1) })).min(1) }),
  z.strictObject({ kind: z.literal("html_deck"), title: z.string().min(1), slides: z.array(z.strictObject({ key: z.string().min(1), title: z.string().min(1), speakerNotes: z.string(), templateContainerKey: z.string().min(1), layoutKey: z.string().min(1), parts: z.array(deckPart).min(1) })).min(1) }),
]);
export type WholeDraft = z.infer<typeof WholeDraftSchema>;
export const ConfirmedCompositionSchema = z.strictObject({
  confirmationId: UuidSchema, proposal: ProposalSchema, confirmedContentVersion: z.int().nonnegative(), renditionId: UuidSchema, emptyBaseRevisionId: UuidSchema,
  templatePackage: TemplatePackageSchema, fixedEvidence: z.array(FixedEvidenceSchema), snapshotHash: HashSchema,
  authorization: z.strictObject({ kind: z.literal("generate_accept_deliver"), messageId: UuidSchema, confirmedAt: UtcTimeSchema }),
});
export type ConfirmedComposition = z.infer<typeof ConfirmedCompositionSchema>;
export const DeliveryIntentSchema = z.strictObject({
  confirmationId: UuidSchema, contentId: UuidSchema, renditionId: UuidSchema, revisionId: UuidSchema, target: DeliveryTargetSchema,
  exportId: UuidSchema, outputJobId: UuidSchema, businessKey: z.string().min(1), requestHash: HashSchema,
});
export type DeliveryIntent = z.infer<typeof DeliveryIntentSchema>;
export const ProgressSchema = z.strictObject({ jobId: UuidSchema, seq: z.int().nonnegative(), phase: z.string(), done: z.int().nonnegative().nullable(), total: z.int().nonnegative().nullable(), message: z.string() }).nullable();
export const AllowedActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("adjust") }), z.strictObject({ kind: z.literal("configure"), capability: z.enum(["text", "feishu"]) }),
  z.strictObject({ kind: z.literal("resume_delivery"), exportId: UuidSchema, decisionVersion: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("verify_remote"), exportId: UuidSchema, operationId: UuidSchema, decisionVersion: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("new_composition") }),
]);
export const DeliveryResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("feishu_doc"), exportId: UuidSchema, revisionId: UuidSchema, documentId: z.string(), url: z.string().url() }),
  z.strictObject({ kind: z.literal("html_deck"), exportId: UuidSchema, revisionId: UuidSchema, previewUrl: z.string(), zip: ExportArtifactSchema }),
]);
const viewCommon = { contentId: UuidSchema, version: z.int().nonnegative(), progress: ProgressSchema };
export const CompositionViewSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...viewCommon, state: z.literal("planning"), step: z.enum(["intent", "recommend"]) }),
  z.strictObject({ ...viewCommon, state: z.literal("proposed"), proposal: ProposalSchema }),
  z.strictObject({ ...viewCommon, state: z.literal("working"), confirmationId: UuidSchema, step: z.enum(["writing", "accepting", "preparing", "delivering"]) }),
  z.strictObject({ ...viewCommon, state: z.literal("blocked"), step: z.enum(["planning", "writing", "accepting", "preparing", "delivering"]), code: ErrorCodeSchema, message: z.string(), actions: z.array(AllowedActionSchema), availableRevisionId: UuidSchema.nullable() }),
  z.strictObject({ ...viewCommon, state: z.literal("delivered"), result: DeliveryResultSchema }),
]);
export type CompositionView = z.infer<typeof CompositionViewSchema>;
export const CompositionIntentSchema = z.strictObject({
  title: z.string().min(1), purpose: z.string().min(1), audience: z.string(), constraints: z.array(z.string()), merchantId: UuidSchema.nullable(), searchTerms: z.array(z.string().min(1)).min(1).max(5), gaps: z.array(CompositionGapSchema),
});
export const CompositionRecommendationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("feishu_doc"), title: z.string().min(1), templateVersionId: UuidSchema, reason: z.string().min(1), evidenceIds: z.array(UuidSchema), gaps: z.array(CompositionGapSchema), sections: z.array(section).min(1) }),
  z.strictObject({ kind: z.literal("html_deck"), title: z.string().min(1), templateVersionId: UuidSchema, reason: z.string().min(1), evidenceIds: z.array(UuidSchema), gaps: z.array(CompositionGapSchema), slides: z.array(slide).min(1) }),
]);
export const CompositionTaskSchema = z.enum(["intent", "recommend", "write_doc", "write_deck"]);
export type CompositionTask = z.infer<typeof CompositionTaskSchema>;
export const CompositionResponseSchema = z.discriminatedUnion("task", [
  z.strictObject({ task: z.literal("intent"), value: CompositionIntentSchema }),
  z.strictObject({ task: z.literal("recommend"), value: CompositionRecommendationSchema }),
  z.strictObject({ task: z.literal("write_doc"), value: WholeDraftSchema.options[0] }),
  z.strictObject({ task: z.literal("write_deck"), value: WholeDraftSchema.options[1] }),
]);
export function parseCompositionResponse(task: CompositionTask, rawResponse: string): z.infer<typeof CompositionResponseSchema> {
  const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }).parse(JSON.parse(rawResponse));
  return CompositionResponseSchema.parse({ task, value: JSON.parse(envelope.choices[0]!.message.content) });
}
