import { z } from "zod";
import type { Locator } from "@dmall/contracts";

export const PROCESSOR_VERSION = {
  pptx: "dcw-local-extract/pptx/2|fflate-0.8.3|fast-xml-parser-5.11.2",
  pdf: "dcw-local-extract/pdf/2|pdfjs-dist-6.4.299",
  html: "dcw-local-extract/html/2|cheerio-1.2.0",
} as const;

export const ExtractionFormatSchema = z.enum(["pptx", "pdf", "html"]);
export type ExtractionFormat = z.infer<typeof ExtractionFormatSchema>;

export const ExtractionStatusSchema = z.enum(["complete", "partial", "blocked"]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

export const PageLocatorSchema = z.strictObject({
  kind: z.literal("page"),
  page: z.int().positive(),
});

export const DomLocatorSchema = z.strictObject({
  kind: z.literal("dom"),
  domPath: z.string().min(1).max(4096),
});

export const ExtractionLocatorSchema = z.discriminatedUnion("kind", [
  PageLocatorSchema,
  DomLocatorSchema,
]);
export type ExtractionLocator = z.infer<typeof ExtractionLocatorSchema>;

export function asContractLocator(locator: ExtractionLocator): Locator {
  return locator;
}

export const ParagraphBlockSchema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.literal("paragraph"),
  text: z.string().min(1),
  locator: ExtractionLocatorSchema,
});
export type ParagraphBlock = z.infer<typeof ParagraphBlockSchema>;

export const ExtractedSectionSchema = z.strictObject({
  id: z.string().min(1).max(200),
  order: z.int().positive(),
  title: z.string().min(1).max(500),
  headingPath: z.string().min(1).max(4096),
  locator: ExtractionLocatorSchema,
  blocks: z.array(ParagraphBlockSchema),
  notes: z.string(),
});
export type ExtractedSection = z.infer<typeof ExtractedSectionSchema>;

export const MediaKindSchema = z.enum([
  "image",
  "gif",
  "video",
  "audio",
  "other",
]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

const MediaBaseShape = {
  id: z.string().min(1).max(200),
  sourceInternalPath: z.string().min(1).max(4096),
};

export const ExtractedMediaSchema = z.strictObject({
  ...MediaBaseShape,
  status: z.literal("extracted"),
  mediaKind: MediaKindSchema,
  mime: z.string().min(1),
  stagedPath: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.int().nonnegative(),
});
export type ExtractedMedia = z.infer<typeof ExtractedMediaSchema>;

export const MissingMediaSchema = z.strictObject({
  ...MediaBaseShape,
  status: z.literal("missing"),
  mediaKind: z.literal("unknown"),
  mime: z.null(),
  errorCode: z.enum([
    "MISSING_DEPENDENCY",
    "PATH_NOT_ALLOWED",
    "EXTERNAL_LINK_BLOCKED",
    "UNSUPPORTED_FORMAT",
    "CAPACITY_EXCEEDED",
  ]),
  message: z.string().min(1),
});
export type MissingMedia = z.infer<typeof MissingMediaSchema>;

export const ExtractedMediaResourceSchema = z.discriminatedUnion("status", [
  ExtractedMediaSchema,
  MissingMediaSchema,
]);
export type ExtractedMediaResource = z.infer<typeof ExtractedMediaResourceSchema>;

export const MediaOccurrenceSchema = z.strictObject({
  id: z.string().min(1).max(200),
  mediaId: z.string().min(1).max(200),
  sectionId: z.string().min(1).max(200),
  locator: ExtractionLocatorSchema,
  headingPath: z.string().min(1).max(4096),
  beforeText: z.string().max(1_000),
  afterText: z.string().max(1_000),
  mediaStatus: z.enum(["extracted", "missing"]),
});
export type MediaOccurrence = z.infer<typeof MediaOccurrenceSchema>;

export const WarningCodeSchema = z.enum([
  "LIBREOFFICE_UNAVAILABLE",
  "PAGE_RENDER_UNAVAILABLE",
  "OCR_BLOCKED",
  "DYNAMIC_HTML_NEEDS_ADAPTER",
  "MISSING_DEPENDENCY",
  "EXTERNAL_LINK_BLOCKED",
  "UNSUPPORTED_MEDIA",
  "UNBOUND_MEDIA",
  "PAGE_TEXT_EMPTY",
  "RELATIONSHIP_MISSING",
  "TEXT_TRUNCATED",
  "MEDIA_LIMIT_REACHED",
  "CAPACITY_EXCEEDED",
]);
export type WarningCode = z.infer<typeof WarningCodeSchema>;

export const ExtractionWarningSchema = z.strictObject({
  code: WarningCodeSchema,
  message: z.string().min(1),
  sectionId: z.string().min(1).nullable(),
  locator: ExtractionLocatorSchema.nullable(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ExtractionWarning = z.infer<typeof ExtractionWarningSchema>;

export const ExtractionCapabilitiesSchema = z.strictObject({
  pageImages: z.enum(["extracted", "unavailable", "disabled", "not_applicable"]),
  libreOffice: z.enum(["available", "unavailable", "not_applicable"]),
  ocr: z.literal("blocked"),
  renderer: z.string().nullable(),
});
export type ExtractionCapabilities = z.infer<typeof ExtractionCapabilitiesSchema>;

export const ExtractedDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: ExtractionFormatSchema,
  processorVersion: z.string().min(1),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFileName: z.string().min(1),
  sourceBytes: z.int().nonnegative(),
  title: z.string().min(1).max(500),
  pageCount: z.int().nonnegative().nullable(),
  sections: z.array(ExtractedSectionSchema),
  media: z.array(ExtractedMediaResourceSchema),
  occurrences: z.array(MediaOccurrenceSchema),
  warnings: z.array(ExtractionWarningSchema),
  status: ExtractionStatusSchema,
  capabilities: ExtractionCapabilitiesSchema,
});
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const ExtractionLimitsSchema = z.strictObject({
  maxInputBytes: z.int().positive().default(2 * GiB),
  maxArchiveEntries: z.int().positive().default(20_000),
  maxExpandedBytes: z.int().positive().default(2 * GiB),
  maxExpansionRatio: z.number().positive().default(100),
  maxMediaFiles: z.int().positive().default(5_000),
  maxSections: z.int().positive().default(2_000),
  maxTextCharsPerDocument: z.int().positive().default(20_000_000),
  maxPageImages: z.int().positive().default(2_000),
  maxHtmlDependencyBytes: z.int().positive().default(512 * MiB),
});
export type ExtractionLimits = z.infer<typeof ExtractionLimitsSchema>;

export const ExtractionOptionsSchema = z
  .strictObject({
    limits: ExtractionLimitsSchema.partial().optional(),
    renderPdfPages: z.boolean().default(true),
  })
  .partial();
export type ExtractionOptions = z.infer<typeof ExtractionOptionsSchema>;

export interface ExtractionInput {
  readonly sourcePath: string;
  readonly stagingDir: string;
  readonly signal?: AbortSignal;
  readonly options?: ExtractionOptions;
}

export type LocalAdapterErrorCode =
  | "SOURCE_UNREADABLE"
  | "UNSUPPORTED_FORMAT"
  | "PATH_NOT_ALLOWED"
  | "CAPACITY_EXCEEDED"
  | "INTERNAL_ERROR";

export class LocalAdapterError extends Error {
  readonly code: LocalAdapterErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LocalAdapterErrorCode,
    message: string,
    options?: {
      readonly retryable?: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LocalAdapterError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details ?? {};
  }
}

export function resolveLimits(options: ExtractionOptions | undefined): ExtractionLimits {
  const parsed = ExtractionOptionsSchema.parse(options ?? {});
  const merged: ExtractionLimits = {
    maxInputBytes: parsed.limits?.maxInputBytes ?? 2 * GiB,
    maxArchiveEntries: parsed.limits?.maxArchiveEntries ?? 20_000,
    maxExpandedBytes: parsed.limits?.maxExpandedBytes ?? 2 * GiB,
    maxExpansionRatio: parsed.limits?.maxExpansionRatio ?? 100,
    maxMediaFiles: parsed.limits?.maxMediaFiles ?? 5_000,
    maxSections: parsed.limits?.maxSections ?? 2_000,
    maxTextCharsPerDocument: parsed.limits?.maxTextCharsPerDocument ?? 20_000_000,
    maxPageImages: parsed.limits?.maxPageImages ?? 2_000,
    maxHtmlDependencyBytes: parsed.limits?.maxHtmlDependencyBytes ?? 512 * MiB,
  };
  return ExtractionLimitsSchema.parse(merged);
}

export function parseExtractedDocument(value: unknown): ExtractedDocument {
  return ExtractedDocumentSchema.parse(value);
}
