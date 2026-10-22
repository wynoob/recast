import { z } from "zod";

export const SchemaVersionSchema = z.literal(1);
export const UuidSchema = z.uuid();
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const UtcTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "时间必须是 UTC ISO8601");
export const IdempotencyKeySchema = UuidSchema;
export const CsrfTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const SelectionHandleSchema = z.string().regex(/^sel1:[A-Za-z0-9_-]+$/);
export type SelectionHandle = z.infer<typeof SelectionHandleSchema>;

export const ContentIdSchema = UuidSchema.brand<"ContentId">();
export const RenditionIdSchema = UuidSchema.brand<"RenditionId">();
export const RevisionIdSchema = UuidSchema.brand<"RevisionId">();
export const NodeIdSchema = UuidSchema;
export const SourceVersionIdSchema = UuidSchema;
export const AssetVersionIdSchema = UuidSchema;
export const TemplateVersionIdSchema = UuidSchema;
export const JobIdSchema = UuidSchema.brand<"JobId">();
export const OperationIdSchema = UuidSchema.brand<"OperationId">();
export const IntentKeySchema = UuidSchema.brand<"IntentKey">();

export type ContentId = z.infer<typeof ContentIdSchema>;
export type RenditionId = z.infer<typeof RenditionIdSchema>;
export type RevisionId = z.infer<typeof RevisionIdSchema>;
export type NodeId = z.infer<typeof NodeIdSchema>;
export type SourceVersionId = z.infer<typeof SourceVersionIdSchema>;
export type AssetVersionId = z.infer<typeof AssetVersionIdSchema>;
export type TemplateVersionId = z.infer<typeof TemplateVersionIdSchema>;
export type JobId = z.infer<typeof JobIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type IntentKey = z.infer<typeof IntentKeySchema>;
export type Hash = z.infer<typeof HashSchema>;

export const WorkerFenceSchema = z.strictObject({
  jobId: JobIdSchema,
  attempt: z.int().positive(),
  leaseOwner: z.string().min(1),
  leaseGeneration: z.int().positive(),
});
export type WorkerFence = z.infer<typeof WorkerFenceSchema>;
