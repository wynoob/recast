import { describe, expect, it } from "vitest";
import {
  AssetDetailV2Schema,
  AssetMapCommitResultSchema,
  AssetMapSelectionSchema,
  AssetMapSummarySchema,
  AssetOccurrenceViewSchema,
  AssetPatchResultSchema,
  AssetSummaryV2Schema,
  ImportCreateRequestSchema,
  SettingsSchema,
  SourceListSchema,
} from "@dmall/contracts";

const id = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const time = "2026-10-21T00:00:00.000Z";

const summary = {
  id,
  mediaKind: "image" as const,
  title: "logo",
  tags: [],
  origins: { title: "source" as const, tags: "source" as const },
  version: 0,
  mime: "image/png",
  bytes: 10,
  availability: "available" as const,
  previewFileUrl: "/api/v1/files/preview",
  posterFileUrl: "/api/v1/files/poster",
  originalFileUrl: "/api/v1/files/original",
  durationMs: null,
  width: 10,
  height: 10,
  merchant: null,
  sourceCount: 1,
  occurrenceCount: 1,
  createdAt: time,
};

describe("T02c shared contracts", () => {
  it("defaults omitted usage summaries to null while keeping the summary schema strict", () => {
    expect(AssetSummaryV2Schema.parse(summary).usageSummary).toBeNull();
    expect(AssetSummaryV2Schema.parse({ ...summary, usageSummary: null }).usageSummary).toBeNull();
    expect(
      AssetSummaryV2Schema.parse({ ...summary, usageSummary: "用于门店介绍" }).usageSummary,
    ).toBe("用于门店介绍");
    expect(
      AssetSummaryV2Schema.safeParse({ ...summary, usageSummary: 123 }).success,
    ).toBe(false);
    expect(AssetSummaryV2Schema.safeParse({ ...summary, unknownField: true }).success).toBe(false);
  });

  it("requires origins, poster, sourceId, and sourceSuggestion", () => {
    expect(AssetSummaryV2Schema.safeParse(summary).success).toBe(true);
    expect(
      AssetSummaryV2Schema.safeParse({ ...summary, origins: undefined }).success,
    ).toBe(false);
    expect(
      AssetSummaryV2Schema.safeParse({ ...summary, posterFileUrl: undefined }).success,
    ).toBe(false);

    const occurrence = {
      id: otherId,
      sourceId: id,
      sourceVersionId: otherId,
      sourceTitle: "来源",
      sourceRelativePath: "docs/source.md",
      locator: {
        schemaVersion: 1,
        kind: "local_file",
        relativePath: "asset.png",
      },
      headingPath: "",
      beforeText: "",
      afterText: "",
      mediaStatus: "available",
      errorCode: null,
    };
    expect(AssetOccurrenceViewSchema.safeParse(occurrence).success).toBe(true);
    expect(
      AssetOccurrenceViewSchema.safeParse({ ...occurrence, sourceId: undefined }).success,
    ).toBe(false);

    const detail = {
      summary,
      metadata: {
        magicMime: "image/png",
        extensionMismatch: false,
        processorVersions: {},
        probe: null,
      },
      humanFields: {
        title: "logo",
        tags: [],
        origins: summary.origins,
      },
      occurrences: [occurrence],
      sourceSuggestion: null,
    };
    expect(AssetDetailV2Schema.safeParse(detail).success).toBe(true);
    expect(
      AssetDetailV2Schema.safeParse({ ...detail, sourceSuggestion: undefined }).success,
    ).toBe(false);
  });

  it("uses 200 Unicode code points for source suggestion titles", () => {
    const suggestion = (title: string) => ({
      origin: "source" as const,
      parserVersion: "dcw-asset-map/1" as const,
      title,
      usageMarkdown: "用法",
      usageText: "用法",
      ignoredSuggestionCount: 0,
      provenance: {
        sourceId: id,
        sourceVersionId: otherId,
        sourceTitle: "说明",
        sourceRelativePath: "docs/source.md",
        sectionHeading: "",
        tableIndex: 0,
        rowIndex: 0,
        lineStart: 3,
        lineEnd: 3,
        fileCell: "asset.png",
        mapIndex: 0,
      },
    });
    expect(
      AssetDetailV2Schema.safeParse({
        ...baseDetail(),
        sourceSuggestion: suggestion("😀".repeat(200)),
      }).success,
    ).toBe(true);
    expect(
      AssetDetailV2Schema.safeParse({
        ...baseDetail(),
        sourceSuggestion: suggestion("😀".repeat(201)),
      }).success,
    ).toBe(false);
    expect(
      AssetDetailV2Schema.safeParse({
        ...baseDetail(),
        sourceSuggestion: suggestion(`A${"😀".repeat(199)}`),
      }).success,
    ).toBe(true);
  });

  it("accepts ordered unique mapping sources and rejects old or duplicate shapes", () => {
    const valid = {
      format: "markdown-asset-table/v1",
      sourceScanItemIds: [id, otherId],
    };
    expect(AssetMapSelectionSchema.safeParse(valid).success).toBe(true);
    expect(
      AssetMapSelectionSchema.safeParse({
        format: "markdown-asset-table/v1",
        sourceScanItemIds: [id, id],
      }).success,
    ).toBe(false);
    expect(
      AssetMapSelectionSchema.safeParse({
        format: "markdown-asset-table/v1",
        sourceScanItemIds: [id, otherId, crypto.randomUUID(), crypto.randomUUID()],
      }).success,
    ).toBe(false);
    expect(
      AssetMapSelectionSchema.safeParse({
        format: "markdown-asset-table/v1",
        sourceVersionIds: [id],
      }).success,
    ).toBe(false);
    expect(
      ImportCreateRequestSchema.safeParse({
        schemaVersion: 1,
        scanId: id,
        selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
        options: {
          generatePreviews: true,
          ocr: "blocked",
          allowExternalModel: false,
          allowFeishu: false,
        },
        assetMap: {
          format: "markdown-asset-table/v1",
          sourceVersionIds: [id],
        },
      }).success,
    ).toBe(false);
  });

  it("validates source list, mapping summary, patch response, and all settings states", () => {
    expect(
      SourceListSchema.safeParse({
        items: [
          {
            id,
            kind: "local_markdown",
            title: "说明",
            status: "active",
            currentVersionId: otherId,
            occurrenceCount: 2,
            missingOccurrenceCount: 1,
            linkedAssetCount: 1,
            createdAt: time,
            updatedAt: time,
          },
        ],
        nextCursor: "1",
        total: 1,
      }).success,
    ).toBe(true);
    expect(
      AssetMapSummarySchema.safeParse({
        requestedSourceCount: 1,
        appliedSourceCount: 1,
        status: "applied",
        entryCount: 1,
        linkedEntryCount: 1,
        warningCount: 0,
        sources: [
          {
            sourceScanItemId: id,
            relativePath: "docs/source.md",
            mapIndex: 0,
            status: "applied",
            sourceVersionId: otherId,
            entryCount: 1,
            linkedEntryCount: 1,
            warningCount: 0,
            errorCode: null,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      AssetPatchResultSchema.safeParse({
        id,
        version: 1,
        title: "标题",
        tags: [],
        origins: { title: "manual", tags: "source" },
      }).success,
    ).toBe(true);
    for (const localImport of [
      "not_implemented_t02",
      "implemented_pending_acceptance",
      "available_t02",
    ]) {
      expect(
        SettingsSchema.safeParse({
          schemaVersion: 1,
          providers: {
            text: { status: "unconfigured" },
            embedding: { status: "unconfigured" },
            vision: { status: "unconfigured" },
            asr: { status: "unconfigured" },
          },
          feishu: { status: "unconfigured" },
          storage: { dataRoot: "/tmp/data", blobStore: "content_addressed" },
          workers: { poolSize: 1, leaseSeconds: 30, heartbeatSeconds: 10 },
          features: {
            localImport,
            documentSearch: "implemented_pending_acceptance",
            localFacts: "implemented_pending_acceptance",
            templates: "not_implemented_t05",
            editor: "not_implemented_t06",
            outputs: "not_implemented_t07",
          },
        }).success,
      ).toBe(true);
    }
  });

  it("keeps the warning array at 5000 and represents warning-limit failure", () => {
    const warning = {
      code: "EMPTY_USE" as const,
      tableIndex: 0,
      rowIndex: 0,
      fileCell: "asset.png",
      detail: "Use 为空",
    };
    const result = (warnings: unknown[]) => ({
      status: "failed",
      parserVersion: "dcw-asset-map/1",
      errorCode: "MAPPING_WARNING_LIMIT_EXCEEDED",
      sourceVersionId: id,
      entryCount: 0,
      warningCount: 5001,
      warnings,
    });
    expect(
      AssetMapCommitResultSchema.safeParse(result(Array(5000).fill(warning))).success,
    ).toBe(true);
    expect(
      AssetMapCommitResultSchema.safeParse(result(Array(5001).fill(warning))).success,
    ).toBe(false);
  });
});

function baseDetail() {
  return {
    summary,
    metadata: {
      magicMime: "image/png",
      extensionMismatch: false,
      processorVersions: {},
      probe: null,
    },
    humanFields: {
      title: "logo",
      tags: [],
      origins: summary.origins,
    },
    occurrences: [],
    sourceSuggestion: null,
  };
}
