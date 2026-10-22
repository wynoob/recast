import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  ImportItemCommitted,
  ItemResultMessage,
  JobResult,
  StagedFile,
  WorkerFence,
} from "@dmall/contracts";
import {
  startT02cApp,
  type T02cTestApp,
} from "./t02c-test-helpers.js";

describe("T02c mapping commit orders and idempotency", () => {
  let app: T02cTestApp;
  const roots: string[] = [];

  beforeAll(async () => {
    app = await startT02cApp();
  }, 30_000);

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await app?.close();
  });

  it("ORDER-A links mapping first and a later media commit without duplicate rows", async () => {
    const fixture = await prepareImport(validMapping());
    await commitMapping(fixture);
    const afterMapping = await detail(fixture.importId);
    expect(afterMapping.mapping).toMatchObject({
      status: "applied",
      entryCount: 1,
      linkedEntryCount: 0,
      sources: [{ status: "applied", entryCount: 1, linkedEntryCount: 0 }],
    });
    expect(await entries(fixture.importId)).toMatchObject([
      { asset_id: null, normalized_relative_path: "public/assets/a.png" },
    ]);
    expect(await assetSuggestion(fixture.mediaItemId)).toBeNull();

    await commitMedia(fixture);
    const afterMedia = await detail(fixture.importId);
    expect(afterMedia.mapping).toMatchObject({
      status: "applied",
      entryCount: 1,
      linkedEntryCount: 1,
    });
    expect(await entries(fixture.importId)).toMatchObject([
      { asset_id: fixture.assetId, normalized_relative_path: "public/assets/a.png" },
    ]);
    const suggestion = await assetSuggestion(fixture.mediaItemId);
    expect(suggestion).toMatchObject({
      title: null,
      usageMarkdown: "用于测试",
      provenance: {
        sourceVersionId: fixture.mappingSourceVersionId(),
        lineStart: 5,
        fileCell: "public/assets/a.png",
      },
    });

    const duplicate = await commitMedia(fixture, false);
    expect(duplicate).toBeNull();
    expect(await entries(fixture.importId)).toHaveLength(1);
    finish(fixture);
    expect((await detail(fixture.importId)).status).toBe("succeeded");
  });

  it("ORDER-B stores media first, then inserts and backfills the mapping row", async () => {
    const fixture = await prepareImport(validMapping());
    await commitMedia(fixture);
    expect(await entries(fixture.importId)).toHaveLength(0);
    expect(await assetSuggestion(fixture.mediaItemId)).toBeNull();

    await commitMapping(fixture);
    expect(await entries(fixture.importId)).toMatchObject([
      { asset_id: fixture.assetId, normalized_relative_path: "public/assets/a.png" },
    ]);
    expect(await assetSuggestion(fixture.mediaItemId)).toMatchObject({
      usageText: "用于测试",
      ignoredSuggestionCount: 0,
    });
    finish(fixture);
    expect((await detail(fixture.importId)).mapping).toMatchObject({
      status: "applied",
      entryCount: 1,
      linkedEntryCount: 1,
    });
  });

  it("counts a linked asset once when multiple mapping rows reference it", async () => {
    const fixture = await prepareImport([
      "# 映射",
      "",
      "| File | Use |",
      "|---|---|",
      "| public/assets/a.png | 第一条说明 |",
      "| public/assets/a.png | 第二条说明 |",
    ].join("\n"));
    await commitMedia(fixture);
    await commitMapping(fixture);
    finish(fixture);
    const value = await detail(fixture.importId);
    expect(value.mapping).toMatchObject({
      status: "applied",
      entryCount: 2,
      linkedEntryCount: 1,
      sources: [{ status: "applied", entryCount: 2, linkedEntryCount: 1 }],
    });
    expect(await assetSuggestion(fixture.mediaItemId)).toMatchObject({
      ignoredSuggestionCount: 1,
    });
  });

  it("ORDER-D keeps media and reports mapping failure as partial with zero entries", async () => {
    const fixture = await prepareImport("# 不是映射表\n");
    await commitMapping(fixture);
    await commitMedia(fixture);
    finish(fixture);
    const value = await detail(fixture.importId);
    expect(value.status).toBe("partial");
    expect(value.mapping).toMatchObject({
      status: "failed",
      entryCount: 0,
      linkedEntryCount: 0,
      sources: [
        {
          status: "failed",
          errorCode: "MAPPING_FORMAT_NOT_FOUND",
        },
      ],
    });
    expect(await entries(fixture.importId)).toHaveLength(0);
    expect(await assetSuggestion(fixture.mediaItemId)).toBeNull();
  });

  it("fails the whole mapping at warning 5001 and inserts zero entries", async () => {
    const unsupported = [
      "| File | Use | Extra |",
      "|---|---|---|",
      "| public/assets/a.png | 用法 | extra |",
      "",
      "",
    ].join("\n");
    const fixture = await prepareImport(unsupported.repeat(5001));
    await commitMapping(fixture);
    await commitMedia(fixture);
    finish(fixture);
    const value = await detail(fixture.importId);
    expect(value.status).toBe("partial");
    expect(value.mapping).toMatchObject({
      status: "failed",
      entryCount: 0,
      sources: [
        {
          status: "failed",
          errorCode: "MAPPING_WARNING_LIMIT_EXCEEDED",
        },
      ],
    });
    expect(await entries(fixture.importId)).toHaveLength(0);
    const stored = app.context.database.db
      .prepare(
        "SELECT result_json FROM import_items WHERE import_job_id = ? AND scan_item_id = ?",
      )
      .get(fixture.importId, fixture.mappingItem.id) as { result_json: string };
    const mapping = JSON.parse(stored.result_json).mapping as {
      warningCount: number;
      warnings: unknown[];
    };
    expect(mapping.warningCount).toBe(5001);
    expect(mapping.warnings).toHaveLength(5000);
  });

  it("keeps a changed mapping source failed before API commit with no entries", async () => {
    const fixture = await prepareImport(validMapping());
    await app.context.imports.acceptItemResult({
      schemaVersion: 1,
      type: "item_result",
      messageId: randomUUID(),
      fence: fixture.fence,
      kind: "import_item",
      item: {
        state: "failed",
        scanItemId: fixture.mappingItem.id,
        relativePath: fixture.mappingPath,
        errorCode: "SOURCE_CHANGED_RESCAN_REQUIRED",
        message: "映射文档在扫描后发生变化",
        retryable: false,
      },
      stagedFiles: [],
    });
    await commitMedia(fixture);
    finish(fixture);
    const value = await detail(fixture.importId);
    expect(value.status).toBe("partial");
    expect(value.mapping).toMatchObject({
      status: "failed",
      sources: [
        {
          status: "failed",
          errorCode: "SOURCE_CHANGED_RESCAN_REQUIRED",
          entryCount: 0,
        },
      ],
    });
    expect(await entries(fixture.importId)).toHaveLength(0);
  });

  it("commits the real 13-row fixture and preserves manual fields across reimport", async () => {
    const fixtureRoot = join(
      process.cwd(),
      "input/Dmall内容工作台-完整交接包-v1.0/materials/local",
    );
    const mappingBytes = await readFile(join(fixtureRoot, "docs/asset-map.md"));
    const brandPath = "public/assets/brand/dmall-logo.png";
    const brandBytes = await readFile(join(fixtureRoot, ...brandPath.split("/")));
    const extraPaths = [
      "public/assets/素材-昨日销量情况.mp4",
      "public/assets/source/DD-3.mp4",
      "public/assets/source/1111.mp4",
      "public/assets/source/DD-8.mp4",
      "public/assets/source/DD-91.mp4",
      "public/assets/source/DDD-2.mp4",
      "public/assets/source/DDD-2-2.mp4",
      "public/assets/source/DD-88.mp4",
      "public/assets/source/d-7.mp4",
      "public/assets/legacy/DD-2.gif",
      "public/assets/legacy/DDD-1.gif",
      "public/assets/legacy/d-10.gif",
    ];
    const fixture = await prepareImport(mappingBytes, {
      mediaPath: brandPath,
      mediaBytes: brandBytes,
      extraPaths,
      mappingPath: "docs/asset-map.md",
    });
    await commitMapping(fixture);
    await commitMedia(fixture);
    finish(fixture);
    const value = await detail(fixture.importId);
    expect(value.mapping).toMatchObject({
      status: "applied",
      entryCount: 13,
      linkedEntryCount: 1,
    });
    const rows = app.context.database.db
      .prepare(
        `SELECT file_cell, usage_markdown, title_text, section_heading, line_start, line_end
         FROM asset_map_entries WHERE import_job_id = ? ORDER BY map_index, table_index, row_index`,
      )
      .all(fixture.importId) as {
      file_cell: string;
      usage_markdown: string;
      title_text: string | null;
      section_heading: string;
      line_start: number;
      line_end: number;
    }[];
    expect(rows).toHaveLength(13);
    expect(rows.every((row) => row.title_text === null)).toBe(true);
    expect(rows[0]).toMatchObject({
      file_cell: "`public/assets/brand/dmall-logo.png`",
      section_heading: "Asset Map / Brand Assets",
      line_start: 9,
      line_end: 9,
    });
    expect(rows[12]).toMatchObject({
      file_cell: "`public/assets/legacy/d-10.gif`",
      section_heading: "Asset Map / Legacy Fallback Assets",
      line_start: 31,
      line_end: 31,
    });
    const fingerprint = app.context.database.db
      .prepare(
        "SELECT fingerprint FROM source_versions WHERE id = ?",
      )
      .get(fixture.mappingSourceVersionId()) as { fingerprint: string };
    expect(fingerprint.fingerprint).toBe(
      "11d62ed05bd119771189cd10c8a10c12258cf47830fb3052c048162f827ce688",
    );
    const suggestion = await assetSuggestion(fixture.mediaItemId);
    expect(suggestion).toMatchObject({
      title: null,
      usageMarkdown:
        "Official Dmall logo downloaded from `https://apppublish.dmall.com/dhc/file/logo@3x.png`; used in the opening system visual and product window chrome.",
      provenance: { sectionHeading: "Asset Map / Brand Assets", lineStart: 9 },
    });

    const assetId = fixture.assetId;
    if (assetId === null) throw new Error("real fixture asset missing");
    const beforePatch = (await app.getJson(`/api/v1/assets/${assetId}`)) as {
      data: { summary: { tags: string[]; title: string } };
    };
    expect(beforePatch.data.summary.tags).toEqual([]);
    expect(beforePatch.data.summary.title).toBe("dmall-logo");
    const patch = {
      schemaVersion: 1,
      expectedVersion: 0,
      title: "手工标题",
      tags: ["手工标签"],
    };
    await app.writeJson("PATCH", `/api/v1/assets/${assetId}`, patch);
    const second = await prepareImport(mappingBytes, {
      mediaPath: brandPath,
      mediaBytes: brandBytes,
      extraPaths,
      mappingPath: "docs/asset-map.md",
    });
    await commitMapping(second);
    await commitMedia(second);
    finish(second);
    const after = (await app.getJson(`/api/v1/assets/${assetId}`)) as {
      data: {
        summary: { title: string; tags: string[]; origins: { title: string; tags: string } };
        humanFields: { origins: { title: string; tags: string } };
      };
    };
    expect(after.data.summary).toMatchObject({
      title: "手工标题",
      tags: ["手工标签"],
      origins: { title: "manual", tags: "manual" },
    });
    expect(after.data.humanFields.origins).toEqual({ title: "manual", tags: "manual" });
  });

  it("rejects a stale lease without writing mapping rows", async () => {
    const fixture = await prepareImport(validMapping());
    const staleFence = {
      ...fixture.fence,
      leaseGeneration: fixture.fence.leaseGeneration + 1,
    };
    await expect(commitMapping(fixture, true, staleFence)).rejects.toMatchObject({
      code: "JOB_STALE_LEASE",
    });
    expect(await entries(fixture.importId)).toHaveLength(0);
  });

  it("cancels an uncommitted mapping as skipped and keeps committed media", async () => {
    const fixture = await prepareImport(validMapping());
    await commitMedia(fixture);
    app.context.jobs.requestCancel(fixture.importId, fixture.fence.leaseGeneration);
    await expect(commitMapping(fixture)).rejects.toMatchObject({ code: "JOB_STALE_LEASE" });
    finish(fixture, "cancelled");
    const value = await detail(fixture.importId);
    expect(value.status).toBe("cancelled");
    expect(value.mapping).toMatchObject({
      status: "skipped",
      sources: [{ status: "skipped", entryCount: 0 }],
    });
    expect(await entries(fixture.importId)).toHaveLength(0);
  });

  it("keeps committed mapping and media after an API restart", async () => {
    const fixture = await prepareImport(validMapping());
    await commitMapping(fixture);
    await commitMedia(fixture);
    finish(fixture);
    const dataRoot = app.config.dataRoot;
    await app.close();
    app = await startT02cApp(dataRoot);
    const value = await detail(fixture.importId);
    expect(value.status).toBe("succeeded");
    expect(value.mapping).toMatchObject({ status: "applied", entryCount: 1, linkedEntryCount: 1 });
    expect(await entries(fixture.importId)).toHaveLength(1);
    expect(await assetSuggestion(fixture.mediaItemId)).toMatchObject({
      usageText: "用于测试",
    });
  });

  async function prepareImport(
    mappingText: string | Uint8Array,
    options: {
      mediaPath?: string;
      mediaBytes?: Buffer;
      extraPaths?: string[];
      mappingPath?: string;
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "dcw-t02c-commit-"));
    roots.push(root);
    const mappingPath = options.mappingPath ?? "docs/asset-map.md";
    const mediaPath = options.mediaPath ?? "public/assets/a.png";
    const mappingBytes = Buffer.from(mappingText);
    const mediaBytes = options.mediaBytes ?? Buffer.from(`mapping-media-${randomUUID()}`);
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, ...mediaPath.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...mappingPath.split("/")), mappingBytes);
    await writeFile(join(root, ...mediaPath.split("/")), mediaBytes);
    const scan = (await app.writeJson("POST", "/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: root,
      options: { generatePreviews: true },
    })) as { data: { scanId: string } };
    const scanId = scan.data.scanId;
    const mappingItem = addScanItem(scanId, mappingPath, mappingBytes, "markdown", "text/markdown");
    const mediaItem = addScanItem(scanId, mediaPath, mediaBytes, "image", "image/png");
    for (const extraPath of options.extraPaths ?? []) {
      if (extraPath === mediaPath) continue;
      const kind = extraPath.endsWith(".gif")
        ? "gif"
        : extraPath.endsWith(".mp4")
          ? "video"
          : "image";
      addScanItem(
        scanId,
        extraPath,
        Buffer.from(`extra-${extraPath}`),
        kind,
        kind === "video" ? "video/mp4" : kind === "gif" ? "image/gif" : "image/png",
      );
    }
    app.context.imports.repository.finalizeScan(scanId, {
      status: "ready",
      manifestHash: hash("manifest"),
    });
    const created = (await app.writeJson("POST", "/api/v1/imports", {
      schemaVersion: 1,
      scanId,
      selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
      assetMap: {
        format: "markdown-asset-table/v1",
        sourceScanItemIds: [mappingItem.id],
      },
    })) as { data: { importId: string } };
    const importId = created.data.importId;
    const assigned = app.context.jobs.assign(importId, `test-${randomUUID()}`);
    const fence = assigned.grant.fence;
    const workspace = join(
      app.config.dataRoot,
      "staging",
      "jobs",
      importId,
      `${fence.attempt}-${fence.leaseGeneration}`,
    );
    await mkdir(workspace, { recursive: true });
    const poster = await sharp({
      create: { width: 3, height: 2, channels: 4, background: "#7c4dff" },
    })
      .webp()
      .toBuffer();
    let assetId: string | null = null;
    return {
      root,
      scanId,
      importId,
      fence,
      workspace,
      mappingItem,
      mediaItem,
      mediaPath,
      mappingPath,
      mappingBytes,
      mediaBytes,
      poster,
      get assetId() {
        return assetId;
      },
      setAssetId(value: string) {
        assetId = value;
      },
      mediaItemId: mediaItem.id,
      mappingSourceVersionId() {
        const row = app.context.database.db
          .prepare("SELECT source_version_id FROM import_items WHERE import_job_id = ? AND scan_item_id = ?")
          .get(importId, mappingItem.id) as { source_version_id: string | null } | undefined;
        if (row?.source_version_id === null || row?.source_version_id === undefined) {
          throw new Error("mapping source version not committed");
        }
        return row.source_version_id;
      },
    };
  }

  function addScanItem(
    scanId: string,
    relativePath: string,
    bytes: Buffer,
    kind: "markdown" | "image" | "gif" | "video",
    mime: string,
  ) {
    const timestamp = new Date().toISOString();
    return app.context.imports.repository.upsertScanItem(scanId, {
      scanItemId: randomUUID(),
      relativePath,
      basename: relativePath.split("/").at(-1) ?? relativePath,
      kind,
      mime,
      bytes: bytes.byteLength,
      mtimeMs: 1,
      deviceId: "1",
      inode: "1",
      magicPrefixHex: kind === "markdown" ? "" : kind === "video" ? "00000018" : "89504e47",
      status: "candidate",
      exclusionCode: null,
      metadata: { extensionMismatch: false, extension: relativePath.split(".").at(-1) ?? "" },
    });
  }

  async function commitMapping(
    fixture: Awaited<ReturnType<typeof prepareImport>>,
    duplicate = false,
    fence: WorkerFence = fixture.fence,
  ): Promise<unknown> {
    const directory = join(fixture.workspace, "items", duplicate ? "mapping-duplicate" : "mapping");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "original.md");
    await writeFile(path, fixture.mappingBytes);
    const staged: StagedFile = {
      role: "original",
      relativePath: `items/${duplicate ? "mapping-duplicate" : "mapping"}/original.md`,
      sha256: hash(fixture.mappingBytes),
      bytes: fixture.mappingBytes.byteLength,
      mime: "text/markdown",
    };
    const item: ImportItemCommitted = {
      state: "committed",
      scanItemId: fixture.mappingItem.id,
      relativePath: fixture.mappingPath,
      kind: "markdown",
      title: "asset-map",
      sha256: hash(fixture.mappingBytes),
      bytes: fixture.mappingBytes.byteLength,
      mime: "text/markdown",
      processorVersions: { markdownParser: "dcw-markdown/1" },
      probe: null,
      markdownOccurrences: [],
    };
    return app.context.imports.acceptItemResult(message(fence, item, [staged]));
  }

  async function commitMedia(
    fixture: Awaited<ReturnType<typeof prepareImport>>,
    fresh = true,
  ): Promise<unknown> {
    const directory = join(fixture.workspace, "items", "media");
    await mkdir(directory, { recursive: true });
    const originalPath = join(directory, "original.png");
    const posterPath = join(directory, "poster.webp");
    await writeFile(originalPath, fixture.mediaBytes);
    await writeFile(posterPath, fixture.poster);
    const item: ImportItemCommitted = {
      state: "committed",
      scanItemId: fixture.mediaItem.id,
      relativePath: fixture.mediaPath,
      kind: "image",
      title: (fixture.mediaPath.split("/").at(-1) ?? "a").replace(/\.[^.]+$/u, ""),
      sha256: hash(fixture.mediaBytes),
      bytes: fixture.mediaBytes.byteLength,
      mime: "image/png",
      processorVersions: { sharp: "sharp/0.35.5" },
      probe: { kind: "image", width: 3, height: 2, format: "png", hasAlpha: true },
      markdownOccurrences: [],
    };
    const staged: StagedFile[] = [
      {
        role: "original",
        relativePath: "items/media/original.png",
        sha256: hash(fixture.mediaBytes),
        bytes: fixture.mediaBytes.byteLength,
        mime: "image/png",
      },
      {
        role: "poster",
        relativePath: "items/media/poster.webp",
        sha256: hash(fixture.poster),
        bytes: fixture.poster.byteLength,
        mime: "image/webp",
      },
    ];
    const result = await app.context.imports.acceptItemResult(
      message(fixture.fence, item, staged),
    );
    if (fresh) {
      const row = app.context.database.db
        .prepare("SELECT asset_id FROM import_items WHERE import_job_id = ? AND scan_item_id = ?")
        .get(fixture.importId, fixture.mediaItem.id) as { asset_id: string | null } | undefined;
      if (row?.asset_id === null || row?.asset_id === undefined) {
        throw new Error("media asset was not committed");
      }
      fixture.setAssetId(row.asset_id);
    }
    return result;
  }

  async function detail(importId: string): Promise<{
    status: string;
    mapping: {
      status: string;
      entryCount: number;
      linkedEntryCount: number;
      sources: { status: string; errorCode: string | null; entryCount: number }[];
    } | null;
  }> {
    return ((await app.getJson(`/api/v1/imports/${importId}`)) as { data: never }).data;
  }

  async function entries(importId: string): Promise<
    { asset_id: string | null; normalized_relative_path: string }[]
  > {
    return app.context.database.db
      .prepare(
        "SELECT asset_id, normalized_relative_path FROM asset_map_entries WHERE import_job_id = ? ORDER BY row_key",
      )
      .all(importId) as {
      asset_id: string | null;
      normalized_relative_path: string;
    }[];
  }

  async function assetSuggestion(scanItemId: string) {
    const row = app.context.database.db
      .prepare(
        "SELECT asset_id FROM import_items WHERE scan_item_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(scanItemId) as { asset_id: string | null } | undefined;
    if (row?.asset_id === null || row?.asset_id === undefined) return null;
    return ((await app.getJson(`/api/v1/assets/${row.asset_id}`)) as {
      data: { sourceSuggestion: unknown };
    }).data.sourceSuggestion;
  }

  function finish(fixture: Awaited<ReturnType<typeof prepareImport>>, state: "succeeded" | "cancelled" = "succeeded") {
    const result: JobResult = {
      schemaVersion: 1,
      jobType: "local_import",
      importId: fixture.importId,
      committed: 1,
      skipped: 0,
      failed: 0,
      assetIds: fixture.assetId === null ? [] : [fixture.assetId],
    };
    app.context.jobs.finish({
      fence: fixture.fence,
      state,
      result,
      error: null,
    });
  }

  function message(fence: WorkerFence, item: ImportItemCommitted, stagedFiles: StagedFile[]): ItemResultMessage {
    return {
      schemaVersion: 1,
      type: "item_result",
      messageId: randomUUID(),
      fence,
      kind: "import_item",
      item,
      stagedFiles,
    };
  }
});

function validMapping(): string {
  return [
    "# 映射",
    "",
    "| File | Use |",
    "|---|---|",
    "| public/assets/a.png | 用于测试 |",
  ].join("\n");
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
