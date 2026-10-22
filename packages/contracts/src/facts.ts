import { z } from "zod";
import {
  SchemaVersionSchema,
  UtcTimeSchema,
  UuidSchema,
} from "./ids.js";
import { LocatorSchema } from "./locators.js";

export const FactValueSchema = z.union([z.number().finite(), z.string().min(1).max(10_000)]);
export type FactValue = z.infer<typeof FactValueSchema>;

export const FactPeriodSchema = z
  .strictObject({
    start: z.iso.date(),
    end: z.iso.date(),
  })
  .refine((value) => value.start <= value.end, "事实统计开始日期不能晚于结束日期");
export type FactPeriod = z.infer<typeof FactPeriodSchema>;

export const FactKindSchema = z.enum(["measured", "estimated", "user_assertion"]);
export type FactKind = z.infer<typeof FactKindSchema>;

export const FactStatusSchema = z.enum(["unverified", "confirmed", "obsolete"]);
export type FactStatus = z.infer<typeof FactStatusSchema>;

const FactIndexTextSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !/[\uD800-\uDFFF]/u.test(value),
    "事实索引文本不能包含孤立代理项",
  )
  .refine(
    (value) => Array.from(value).length <= 1_200,
    "事实索引文本不能超过 1200 个 Unicode 码点",
  );

export const FactVersionViewSchema = z.strictObject({
  id: UuidSchema,
  factId: UuidSchema,
  version: z.int().positive(),
  value: FactValueSchema,
  unit: z.string().min(1).max(100),
  merchantId: UuidSchema.nullable(),
  period: FactPeriodSchema.nullable(),
  kind: FactKindSchema,
  sourceVersionId: UuidSchema,
  sourceLocator: LocatorSchema,
  status: FactStatusSchema,
  indexText: FactIndexTextSchema,
  createdAt: UtcTimeSchema,
});
export type FactVersionView = z.infer<typeof FactVersionViewSchema>;

export const FactEntitySchema = z.strictObject({
  id: UuidSchema,
  canonicalKey: z.string().min(1).max(500),
  currentVersionId: UuidSchema,
  currentVersion: FactVersionViewSchema,
  createdAt: UtcTimeSchema,
  updatedAt: UtcTimeSchema,
});
export type FactEntity = z.infer<typeof FactEntitySchema>;

export const FactVersionInputSchema = z.strictObject({
  value: FactValueSchema,
  unit: z.string().trim().min(1).max(100),
  merchantId: UuidSchema.nullable(),
  period: FactPeriodSchema.nullable(),
  kind: FactKindSchema,
  sourceVersionId: UuidSchema,
  sourceLocator: LocatorSchema,
  status: FactStatusSchema.default("unverified"),
  indexText: FactIndexTextSchema,
});
export type FactVersionInput = z.infer<typeof FactVersionInputSchema>;

export const CreateFactRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  canonicalKey: z.string().trim().min(1).max(500),
  version: FactVersionInputSchema,
});
export type CreateFactRequest = z.infer<typeof CreateFactRequestSchema>;

export const CreateFactVersionRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expectedVersionId: UuidSchema,
  version: FactVersionInputSchema,
});
export type CreateFactVersionRequest = z.infer<typeof CreateFactVersionRequestSchema>;

export const FactListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
