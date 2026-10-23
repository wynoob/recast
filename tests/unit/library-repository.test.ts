import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BlobStore, openDatabase } from "@dmall/storage";
import { DocumentRepository } from "../../apps/server/src/documents/repository.js";
import { IdempotencyRepository } from "../../apps/server/src/idempotency.js";
import { LibraryRepository } from "../../apps/server/src/library-repository.js";
import { KeywordIndexService } from "../../apps/server/src/retrieval/index-service.js";

it("lists real mapped usage up to 240 characters, leaves unmapped usage null, and keeps detail usage complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcw-library-summary-"));
  const { db } = await openDatabase({ dbPath: join(root, "workbench.sqlite") });
  try {
    const blobs = new BlobStore(root);
    const library = new LibraryRepository(
      db,
      blobs,
      new IdempotencyRepository(db),
      new DocumentRepository(db),
      new KeywordIndexService(db, blobs),
    );
    const time = "2026-10-23T00:00:00.000Z";
    const hash = "a".repeat(64);
    const assetId = randomUUID();
    const unmappedId = randomUUID();
    const sourceId = randomUUID();
    const versionId = randomUUID();
    const jobId = randomUUID();
    const scanId = randomUUID();
    const scanItemId = randomUUID();
    const expectedSummary = `${"用于门店展示".repeat(39)}门店展😀😀😀`;
    const usageText = `${expectedSummary}，保留在详情中的完整用途。`;
    const usageMarkdown = `**${usageText}**`;

    db.prepare(
      `INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at)
       VALUES (?, 'asset.png', 'image/png', 10, ?)`,
    ).run(hash, time);
    db.prepare(
      `INSERT INTO blobs(sha256, relative_path, mime, bytes, created_at)
       VALUES (?, 'unmapped.png', 'image/png', 10, ?)`,
    ).run("b".repeat(64), time);
    for (const [id, blobHash] of [[assetId, hash], [unmappedId, "b".repeat(64)]]) {
      db.prepare(
        `INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at)
         VALUES (?, ?, 'image', ?, ?)`,
      ).run(id, blobHash, time, time);
    }
    db.prepare(
      `INSERT INTO sources(id, kind, canonical_key, title, status, created_at, updated_at)
       VALUES (?, 'local_markdown', 'usage-map', '用途映射', 'active', ?, ?)`,
    ).run(sourceId, time, time);
    db.prepare(
      `INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(versionId, sourceId, hash, hash, time, time);
    db.prepare(
      `INSERT INTO jobs(id, type, input_hash, input_json, state, phase, created_at, updated_at)
       VALUES (?, 'local_import', ?, '{}', 'succeeded', 'done', ?, ?)`,
    ).run(jobId, hash, time, time);
    db.prepare(
      `INSERT INTO import_scans(id, job_id, source_kind, status, scanner_version,
                                counts_json, exclusions_json, created_at, updated_at)
       VALUES (?, ?, 'local_directory', 'consumed', 'dcw-directory-scan/1', '{}', '[]', ?, ?)`,
    ).run(scanId, jobId, time, time);
    db.prepare(
      `INSERT INTO scan_items(id, scan_id, ordinal, relative_path, basename, media_kind_guess,
                              bytes, mtime_ms, device_id, inode, status, metadata_json, created_at)
       VALUES (?, ?, 0, 'usage.md', 'usage.md', 'markdown', 10, 0, '1', '1', 'candidate', '{}', ?)`,
    ).run(scanItemId, scanId, time);
    db.prepare(
      `INSERT INTO asset_map_entries(
         id, import_job_id, scan_id, mapping_scan_item_id, mapping_source_version_id,
         map_index, table_index, row_index, row_key, section_heading, file_cell,
         normalized_relative_path, title_text, usage_markdown, usage_text, line_start, line_end,
         parser_version, asset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'row-0', '门店展示', 'asset.png', 'asset.png',
               '映射标题不应作为用途', ?, ?, 3, 3, 'dcw-asset-map/1', ?, ?, ?)`,
    ).run(randomUUID(), jobId, scanId, scanItemId, versionId, usageMarkdown, usageText, assetId, time, time);

    const list = await library.listAssets({ limit: 20, offset: 0 });
    expect(list.items).toHaveLength(2);
    expect(list.items.find((asset) => asset.id === assetId)?.usageSummary).toBe(expectedSummary);
    expect(list.items.find((asset) => asset.id === unmappedId)?.usageSummary).toBeNull();

    const detail = await library.getAssetDetail(assetId);
    expect(detail.summary.usageSummary).toBe(expectedSummary);
    expect(detail.sourceSuggestion).toMatchObject({ usageText, usageMarkdown });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
