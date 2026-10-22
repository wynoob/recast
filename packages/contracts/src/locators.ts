import { z } from "zod";
import { SchemaVersionSchema } from "./ids.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !CONTROL_CHARACTERS.test(value), "路径不能包含控制字符")
  .refine((value) => !value.startsWith("/"), "路径不能是绝对路径")
  .refine((value) => !value.includes("\\"), "路径不能使用反斜杠")
  .refine(
    (value) => value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "路径不能包含空段、点段或越界段",
  );
export type SafeRelativePath = z.infer<typeof SafeRelativePathSchema>;

export const BlockLocatorSchema = z.strictObject({
  kind: z.literal("block"),
  blockId: z.string().min(1),
});

export const PageLocatorSchema = z.strictObject({
  kind: z.literal("page"),
  page: z.int().positive(),
});

export const DomLocatorSchema = z.strictObject({
  kind: z.literal("dom"),
  domPath: z.string().min(1),
});

export const TimeLocatorSchema = z
  .strictObject({
    kind: z.literal("time"),
    startMs: z.int().nonnegative(),
    endMs: z.int().positive(),
  })
  .refine((value) => value.startMs < value.endMs, "时间定位必须满足 startMs < endMs");

export const LocalFileLocatorSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("local_file"),
  relativePath: SafeRelativePathSchema,
});

export const MarkdownLocatorSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("markdown"),
  line: z.int().min(1),
  column: z.int().min(1),
  ordinal: z.int().nonnegative(),
  rawTarget: z.string().min(1).max(4096),
  normalizedRelativePath: z.string().min(1).max(4096),
  resolution: z.enum(["inside_root", "missing", "outside_root", "external_url"]),
});
export type MarkdownLocator = z.infer<typeof MarkdownLocatorSchema>;

export const MarkdownTextLocatorSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("markdown_text"),
  line: z.int().min(1),
  column: z.int().min(1),
});
export type MarkdownTextLocator = z.infer<typeof MarkdownTextLocatorSchema>;

export const LocatorSchema = z.union([
  BlockLocatorSchema,
  PageLocatorSchema,
  DomLocatorSchema,
  TimeLocatorSchema,
  LocalFileLocatorSchema,
  MarkdownLocatorSchema,
  MarkdownTextLocatorSchema,
]);
export type Locator = z.infer<typeof LocatorSchema>;

export const SourceLocatorSchema = LocatorSchema;
export type SourceLocator = Locator;

export const OccurrenceLocatorSchema = LocatorSchema;
export type OccurrenceLocator = z.infer<typeof OccurrenceLocatorSchema>;
