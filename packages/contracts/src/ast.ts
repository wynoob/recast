import { z } from "zod";
import {
  AssetVersionIdSchema,
  NodeIdSchema,
  SchemaVersionSchema,
  SourceVersionIdSchema,
  TemplateVersionIdSchema,
  UtcTimeSchema,
  UuidSchema,
} from "./ids.js";
import {
  LocatorSchema,
  SourceLocatorSchema,
  type Locator,
  type SourceLocator,
} from "./locators.js";

export { LocatorSchema, SourceLocatorSchema };
export type { Locator, SourceLocator };

export const ContentKindSchema = z.enum(["feishu_doc", "html_deck"]);
export type ContentKind = z.infer<typeof ContentKindSchema>;

export const ProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("source"),
    sourceVersionId: SourceVersionIdSchema,
    locator: LocatorSchema,
  }),
  z.strictObject({ kind: z.literal("fact"), factVersionId: UuidSchema }),
  z.strictObject({ kind: z.literal("user_assertion"), messageId: UuidSchema }),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

const HttpLinkSchema = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:", "mailto:"].includes(url.protocol);
    } catch {
      return false;
    }
  }, "链接只支持 http、https 或 mailto");

export const InlineMarkSchema = z.union([
  z.enum(["bold", "italic", "code"]),
  z.strictObject({ type: z.literal("link"), href: HttpLinkSchema }),
]);
export type InlineMark = z.infer<typeof InlineMarkSchema>;

export const InlineSchema = z.strictObject({
  text: z.string(),
  marks: z.array(InlineMarkSchema),
});
export const InlinesSchema = z.array(InlineSchema);
export type Inlines = z.infer<typeof InlinesSchema>;

export const BlockTypeSchema = z.enum([
  "heading",
  "paragraph",
  "list",
  "image",
  "video",
  "table",
  "callout",
  "divider",
  "readonly_source_block",
]);
export type BlockType = z.infer<typeof BlockTypeSchema>;

const BlockBaseShape = {
  id: NodeIdSchema,
  provenance: z.array(ProvenanceSchema).default([]),
  locks: z.array(z.string()).default([]),
  slotId: z.string().min(1).nullable().optional(),
};

export const HeadingBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("heading"),
  level: z.int().min(1).max(6),
  text: z.string(),
});
export const ParagraphBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("paragraph"),
  inlines: InlinesSchema,
});
export const ListBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z.array(InlinesSchema),
});
export const ImageBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("image"),
  assetVersionId: AssetVersionIdSchema,
  derivativeId: UuidSchema.nullable(),
  occurrenceId: UuidSchema,
  caption: z.string(),
  alt: z.string(),
  fit: z.enum(["contain", "cover"]),
});
export const VideoBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("video"),
  assetVersionId: AssetVersionIdSchema,
  segmentId: UuidSchema.nullable(),
  posterDerivativeId: UuidSchema,
  caption: z.string(),
});
export const TableBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("table"),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(InlinesSchema)),
});
export const CalloutBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("callout"),
  inlines: InlinesSchema,
});
export const DividerBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("divider"),
});
export const ReadonlySourceBlockSchema = z.strictObject({
  ...BlockBaseShape,
  type: z.literal("readonly_source_block"),
  sourceVersionId: SourceVersionIdSchema,
  locator: LocatorSchema,
  sourceBlockType: z.string().min(1),
  sourceUrl: HttpLinkSchema,
  summary: z.string(),
  previewDerivativeId: UuidSchema.nullable(),
});

export const BlockSchema = z.discriminatedUnion("type", [
  HeadingBlockSchema,
  ParagraphBlockSchema,
  ListBlockSchema,
  ImageBlockSchema,
  VideoBlockSchema,
  TableBlockSchema,
  CalloutBlockSchema,
  DividerBlockSchema,
  ReadonlySourceBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;

export const DeckLayoutSchema = z.enum([
  "cover",
  "section",
  "title-body-media",
  "two-column",
  "metric-evidence",
  "steps",
  "table",
  "closing",
]);
export type DeckLayout = z.infer<typeof DeckLayoutSchema>;

export const SectionSchema = z.strictObject({
  id: NodeIdSchema,
  title: z.string(),
  blocks: z.array(BlockSchema),
  locks: z.array(z.string()).default([]),
});
export const SlideSchema = z.strictObject({
  id: NodeIdSchema,
  layout: DeckLayoutSchema,
  title: z.string(),
  blocks: z.array(BlockSchema),
  speakerNotes: z.string(),
  locks: z.array(z.string()).default([]),
});
export type Section = z.infer<typeof SectionSchema>;
export type Slide = z.infer<typeof SlideSchema>;

export const DocAstSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("feishu_doc"),
  title: z.string(),
  locks: z.array(z.string()).default([]),
  sections: z.array(SectionSchema),
  speakerNotes: z.record(z.string(), z.string()),
});
export const DeckAstSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  kind: z.literal("html_deck"),
  title: z.string(),
  locks: z.array(z.string()).default([]),
  canvas: z.strictObject({
    width: z.literal(1600),
    height: z.literal(900),
  }),
  slides: z.array(SlideSchema),
});
export const AstSchema = z.discriminatedUnion("kind", [DocAstSchema, DeckAstSchema]);
export type DocAst = z.infer<typeof DocAstSchema>;
export type DeckAst = z.infer<typeof DeckAstSchema>;
export type Ast = z.infer<typeof AstSchema>;

export const RevisionCreatedBySchema = z.enum([
  "user",
  "ai_accepted",
  "feishu_pull",
  "restore",
  "import",
]);

export const RevisionRecordSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: UuidSchema,
  renditionId: UuidSchema,
  parentId: UuidSchema.nullable(),
  templateVersionId: TemplateVersionIdSchema.nullable(),
  ast: AstSchema,
  createdBy: RevisionCreatedBySchema,
  reason: z.string(),
  createdAt: UtcTimeSchema,
});
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;

export const FieldEditSchema = z.discriminatedUnion("path", [
  z.strictObject({ path: z.literal("title"), value: z.string() }),
  z.strictObject({ path: z.literal("text"), value: z.string() }),
  z.strictObject({ path: z.literal("level"), value: z.int().min(1).max(6) }),
  z.strictObject({ path: z.literal("inlines"), value: InlinesSchema }),
  z.strictObject({ path: z.literal("ordered"), value: z.boolean() }),
  z.strictObject({ path: z.literal("items"), value: z.array(InlinesSchema) }),
  z.strictObject({ path: z.literal("assetVersionId"), value: AssetVersionIdSchema }),
  z.strictObject({ path: z.literal("derivativeId"), value: UuidSchema.nullable() }),
  z.strictObject({ path: z.literal("occurrenceId"), value: UuidSchema }),
  z.strictObject({ path: z.literal("segmentId"), value: UuidSchema.nullable() }),
  z.strictObject({ path: z.literal("posterDerivativeId"), value: UuidSchema }),
  z.strictObject({ path: z.literal("caption"), value: z.string() }),
  z.strictObject({ path: z.literal("alt"), value: z.string() }),
  z.strictObject({ path: z.literal("fit"), value: z.enum(["contain", "cover"]) }),
  z.strictObject({ path: z.literal("columns"), value: z.array(z.string()).min(1) }),
  z.strictObject({ path: z.literal("rows"), value: z.array(z.array(InlinesSchema)) }),
  z.strictObject({ path: z.literal("speakerNotes"), value: z.string() }),
  z.strictObject({ path: z.literal("locks"), value: z.array(z.string()) }),
  z.strictObject({ path: z.literal("layout"), value: DeckLayoutSchema }),
  z.strictObject({ path: z.literal("slotId"), value: z.string().min(1).nullable() }),
  z.strictObject({ path: z.literal("provenance"), value: z.array(ProvenanceSchema) }),
]);
export type FieldEdit = z.infer<typeof FieldEditSchema>;

export const FieldPathSchema = z.union(FieldEditSchema.options.map((field) => field.shape.path));
export type FieldPath = FieldEdit["path"];

export const SetFieldOperationSchema = z.discriminatedUnion("path",
  [FieldEditSchema.options[0].extend({ op: z.literal("setField"), nodeId: NodeIdSchema }),
    ...FieldEditSchema.options.slice(1).map((field) => field.extend({ op: z.literal("setField"), nodeId: NodeIdSchema }))],
);

const InsertableNodeSchema = z.union([BlockSchema, SectionSchema, SlideSchema]);

const InsertOperationSchema = z.union([
  z.strictObject({
    op: z.literal("insertNode"),
    parentId: NodeIdSchema,
    afterId: NodeIdSchema.nullable(),
    node: InsertableNodeSchema,
  }),
  z.strictObject({
    op: z.literal("insertNode"),
    parentId: NodeIdSchema,
    beforeId: NodeIdSchema,
    node: InsertableNodeSchema,
  }),
]);

const MoveOperationSchema = z.union([
  z.strictObject({
    op: z.literal("moveNode"),
    nodeId: NodeIdSchema,
    parentId: NodeIdSchema,
    afterId: NodeIdSchema.nullable(),
  }),
  z.strictObject({
    op: z.literal("moveNode"),
    nodeId: NodeIdSchema,
    parentId: NodeIdSchema,
    beforeId: NodeIdSchema,
  }),
]);

export const EditOperationSchema = z.union([
  SetFieldOperationSchema,
  InsertOperationSchema,
  z.strictObject({ op: z.literal("removeNode"), nodeId: NodeIdSchema }),
  MoveOperationSchema,
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;

export const ParsedEditOperationSchema = EditOperationSchema;
export type ParsedEditOperation = EditOperation;
export type InsertableNode = z.infer<typeof InsertableNodeSchema>;

export function parseEditOperation(input: unknown): EditOperation {
  return EditOperationSchema.parse(input);
}
