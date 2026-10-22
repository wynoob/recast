import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@dmall/storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T02c migration 004", () => {
  it("creates the narrow mapping table and indexes after 001..004", async () => {
    const root = await tempRoot("dcw-t02c-fresh-");
    const opened = await openDatabase({
      dbPath: join(root, "db", "workbench.sqlite"),
      backupDir: join(root, "backups"),
    });
    try {
      expect(opened.appliedMigrations).toHaveLength(9);
      expect(opened.info.migrationCount).toBe(9);
      const table = opened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_map_entries'")
        .get();
      expect(table).toEqual({ name: "asset_map_entries" });
      const indexes = opened.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_asset_map_entries_%' ORDER BY name",
        )
        .all();
      expect(indexes).toEqual([
        { name: "idx_asset_map_entries_asset" },
        { name: "idx_asset_map_entries_job" },
        { name: "idx_asset_map_entries_link" },
        { name: "idx_asset_map_entries_source" },
      ]);
      expect(opened.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  it("upgrades a 003 database without changing source, canonical, or manual rows", async () => {
    const root = await tempRoot("dcw-t02c-upgrade-");
    const oldMigrations = join(root, "migrations-003");
    await mkdir(oldMigrations);
    for (const name of [
      "001_initial.sql",
      "002_t02_local_import.sql",
      "003_t02_import_invariants.sql",
    ]) {
      await copyFile(
        join(process.cwd(), "packages/storage/migrations", name),
        join(oldMigrations, name),
      );
    }
    const dbPath = join(root, "db", "workbench.sqlite");
    const old = await openDatabase({
      dbPath,
      backupDir: join(root, "backups"),
      migrationsDir: oldMigrations,
    });
    const seeded = seedMappingRows(old.db);
    const before = {
      sources: old.db.prepare("SELECT * FROM sources").all(),
      versions: old.db.prepare(
        "SELECT id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at FROM source_versions",
      ).all(),
      blobs: old.db.prepare("SELECT * FROM blobs").all(),
      occurrences: old.db.prepare(
        "SELECT id, source_version_id, asset_id, locator_json, occurrence_index, heading_path, before_text, after_text, media_status, version, created_at, updated_at, media_error_code, position_key, canonical_id FROM occurrences ORDER BY id",
      ).all(),
      canonical: old.db.prepare(
        "SELECT id, source_version_id, asset_id, locator_json, occurrence_index, heading_path, before_text, after_text, media_status, version, created_at, updated_at, media_error_code, position_key, canonical_id FROM canonical_occurrences ORDER BY id",
      ).all(),
      assetVersions: old.db.prepare("SELECT * FROM asset_versions").all(),
    };
    old.db.close();

    const upgraded = await openDatabase({ dbPath, backupDir: join(root, "backups") });
    try {
      expect(upgraded.appliedMigrations).toEqual([
        "004_t02c_asset_map_and_source_list",
        "005_t06_authoring_core",
        "006_t06_provider_journal",
        "007_t03_t04_document_search",
        "008_t05_template_validation",
        "009_t07_outputs",
      ]);
      expect(upgraded.backupPath).not.toBeNull();
      expect(upgraded.db.prepare("SELECT * FROM sources").all()).toEqual(before.sources);
      expect(upgraded.db.prepare(
        "SELECT id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at FROM source_versions",
      ).all()).toEqual(before.versions);
      expect(upgraded.db.prepare("SELECT * FROM blobs").all()).toEqual(before.blobs);
      expect(upgraded.db.prepare(
        "SELECT id, source_version_id, asset_id, locator_json, occurrence_index, heading_path, before_text, after_text, media_status, version, created_at, updated_at, media_error_code, position_key, canonical_id FROM occurrences ORDER BY id",
      ).all()).toEqual(
        before.occurrences,
      );
      expect(upgraded.db.prepare(
        "SELECT id, source_version_id, asset_id, locator_json, occurrence_index, heading_path, before_text, after_text, media_status, version, created_at, updated_at, media_error_code, position_key, canonical_id FROM canonical_occurrences ORDER BY id",
      ).all()).toEqual(
        before.canonical,
      );
      expect(upgraded.db.prepare("SELECT * FROM asset_versions").all()).toEqual(
        before.assetVersions,
      );
      expect(upgraded.db.pragma("foreign_key_check")).toEqual([]);
      expect(upgraded.db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(seeded.sourceVersionId).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      upgraded.db.close();
    }
  });

  it("upserts one row per rowKey and enforces byte and code point boundaries", async () => {
    const root = await tempRoot("dcw-t02c-constraints-");
    const opened = await openDatabase({
      dbPath: join(root, "db", "workbench.sqlite"),
      backupDir: join(root, "backups"),
    });
    try {
      const seeded = seedMappingRows(opened.db);
      const entry = {
        importJobId: seeded.importJobId,
        scanId: seeded.scanId,
        mappingScanItemId: seeded.scanItemId,
        mappingSourceVersionId: seeded.sourceVersionId,
        fileCell: "public/assets/a.png",
        usage: "Use",
        title: null as string | null,
      };
      insertEntry(opened.db, entry);
      insertEntry(opened.db, { ...entry, usage: "Use updated" });
      expect(
        opened.db
          .prepare(
            "SELECT COUNT(*) AS count, MAX(usage_markdown) AS usage FROM asset_map_entries",
          )
          .get(),
      ).toEqual({ count: 1, usage: "Use updated" });

      expect(() =>
        insertEntry(opened.db, {
          ...entry,
          fileCell: "a".repeat(16_384),
          rowKey: "t0:r1",
        }),
      ).not.toThrow();
      expect(() =>
        insertEntry(opened.db, {
          ...entry,
          fileCell: "a".repeat(16_385),
          rowKey: "t0:r2",
        }),
      ).toThrow();

      expect(() =>
        insertEntry(opened.db, {
          ...entry,
          title: "😀".repeat(200),
          rowKey: "t0:r3",
        }),
      ).not.toThrow();
      expect(() =>
        insertEntry(opened.db, {
          ...entry,
          title: "😀".repeat(201),
          rowKey: "t0:r4",
        }),
      ).toThrow();

      expect(() =>
        opened.db
          .prepare(
            `INSERT INTO asset_map_entries
              (id, import_job_id, scan_id, mapping_scan_item_id, mapping_source_version_id,
               map_index, table_index, row_index, row_key, section_heading, file_cell,
               normalized_relative_path, title_text, usage_markdown, usage_text,
               line_start, line_end, parser_version, asset_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, 0, 9, 't0:r9', '', 'x', 'x', NULL, 'x', 'x', 1, 1,
                     'dcw-asset-map/1', NULL, ?, ?)`,
          )
          .run(
            randomUUID(),
            seeded.importJobId,
            seeded.scanId,
            seeded.scanItemId,
            randomUUID(),
            new Date().toISOString(),
            new Date().toISOString(),
          ),
      ).toThrow();
    } finally {
      opened.db.close();
    }
  });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface Seeded {
  importJobId: string;
  scanId: string;
  scanItemId: string;
  sourceVersionId: string;
}

function seedMappingRows(db: Awaited<ReturnType<typeof openDatabase>>["db"]): Seeded {
  const time = "2026-10-21T00:00:00.000Z";
  const blobHash = "a".repeat(64);
  const importJobId = randomUUID();
  const scanJobId = randomUUID();
  const scanId = randomUUID();
  const scanItemId = randomUUID();
  const sourceId = randomUUID();
  const sourceVersionId = randomUUID();
  const assetId = randomUUID();
  const occurrenceId = randomUUID();
  db.prepare(
    `INSERT INTO jobs(id, type, input_hash, input_json, idempotency_key, state, phase,
      attempt, max_attempts, checkpoint_json, result_json, error_json, lease_owner,
      lease_generation, lease_until, next_run_at, cancel_requested, created_at, updated_at)
     VALUES(?, 'local_import', ?, ?, NULL, 'queued', 'queued', 0, 3, NULL, NULL, NULL,
      NULL, 0, NULL, NULL, 0, ?, ?)`,
  ).run(importJobId, "b".repeat(64), "{}", time, time);
  db.prepare(
    `INSERT INTO jobs(id, type, input_hash, input_json, idempotency_key, state, phase,
      attempt, max_attempts, checkpoint_json, result_json, error_json, lease_owner,
      lease_generation, lease_until, next_run_at, cancel_requested, created_at, updated_at)
     VALUES(?, 'local_scan', ?, ?, NULL, 'succeeded', 'done', 1, 3, NULL, NULL, NULL,
      NULL, 0, NULL, NULL, 0, ?, ?)`,
  ).run(scanJobId, "c".repeat(64), "{}", time, time);
  db.prepare(
    `INSERT INTO import_scans(id, job_id, source_kind, root_path, root_identity, status,
      scanner_version, manifest_hash, counts_json, exclusions_json, selection_hash,
      import_job_id, expires_at, created_at, updated_at)
     VALUES(?, ?, 'local_directory', '/tmp/root', 'root', 'consumed', 'dcw-directory-scan/1',
      ?, '{}', '[]', ?, ?, ?, ?, ?)`,
  ).run(scanId, scanJobId, "d".repeat(64), "e".repeat(64), importJobId, time, time, time);
  db.prepare(
    `INSERT INTO scan_items(id, scan_id, ordinal, relative_path, basename, media_kind_guess,
      mime_guess, bytes, mtime_ms, device_id, inode, magic_prefix_hex, status, exclusion_code,
      metadata_json, created_at)
     VALUES(?, ?, 0, 'docs/map.md', 'map.md', 'markdown', 'text/markdown', 10, 1, '1', '1',
      NULL, 'candidate', NULL, '{}', ?)`,
  ).run(scanItemId, scanId, time);
  db.prepare("INSERT INTO blobs VALUES(?, 'blobs/sha256/aa/a', 'text/markdown', 10, ?)").run(
    blobHash,
    time,
  );
  db.prepare(
    `INSERT INTO sources(id, kind, canonical_key, title, original_uri, status, created_at, updated_at)
     VALUES(?, 'local_markdown', 'legacy-source', '说明', NULL, 'active', ?, ?)`,
  ).run(sourceId, time, time);
  db.prepare(
    `INSERT INTO source_versions(id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at)
     VALUES(?, ?, ?, ?, NULL, ?, ?)`,
  ).run(sourceVersionId, sourceId, blobHash, blobHash, time, time);
  db.prepare(
    `INSERT INTO assets(id, blob_hash, media_kind, created_at, updated_at)
     VALUES(?, ?, 'image', ?, ?)`,
  ).run(assetId, blobHash, time, time);
  db.prepare(
    `INSERT INTO asset_versions(id, asset_id, title, metadata_json, human_fields_json, version, created_at)
     VALUES(?, ?, '人工标题', '{}', ?, 0, ?)`,
  ).run(
    randomUUID(),
    assetId,
    JSON.stringify({
      title: "人工标题",
      tags: ["人工标签"],
      origins: { title: "manual", tags: "manual" },
      merchant: null,
    }),
    time,
  );
  db.prepare(
    `INSERT INTO occurrences(id, source_version_id, asset_id, locator_json, position_key,
      occurrence_index, heading_path, before_text, after_text, media_status, media_error_code,
      version, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, 0, '', '', '', 'available', NULL, 0, ?, ?)`,
  ).run(
    occurrenceId,
    sourceVersionId,
    assetId,
    JSON.stringify({ schemaVersion: 1, kind: "local_file", relativePath: "public/assets/a.png" }),
    JSON.stringify(["local_file", "public/assets/a.png"]),
    time,
    time,
  );
  return { importJobId, scanId, scanItemId, sourceVersionId };
}

function insertEntry(
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  input: {
    importJobId: string;
    scanId: string;
    mappingScanItemId: string;
    mappingSourceVersionId: string;
    fileCell: string;
    usage: string;
    title: string | null;
    rowKey?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO asset_map_entries
      (id, import_job_id, scan_id, mapping_scan_item_id, mapping_source_version_id,
       map_index, table_index, row_index, row_key, section_heading, file_cell,
       normalized_relative_path, title_text, usage_markdown, usage_text,
       line_start, line_end, parser_version, asset_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, '', ?, ?, ?, ?, ?, 1, 1, 'dcw-asset-map/1', NULL, ?, ?)
     ON CONFLICT(import_job_id, mapping_source_version_id, row_key) DO UPDATE SET
       usage_markdown = excluded.usage_markdown,
       usage_text = excluded.usage_text,
       updated_at = excluded.updated_at`,
  ).run(
    randomUUID(),
    input.importJobId,
    input.scanId,
    input.mappingScanItemId,
    input.mappingSourceVersionId,
    input.rowKey ?? "t0:r0",
    input.fileCell,
    input.fileCell,
    input.title,
    input.usage,
    input.usage,
    now,
    now,
  );
}
