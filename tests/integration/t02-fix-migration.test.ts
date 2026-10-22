import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "@dmall/storage";
it("upgrades 001/002 in place, keeps every referenced legacy occurrence ID and immutable snapshot, and counts one canonical position", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-"));
  const migrations = join(root, "old");
  await mkdir(migrations);
  for (const name of ["001_initial.sql", "002_t02_local_import.sql"])
    await copyFile(join(process.cwd(), "packages/storage/migrations", name), join(migrations, name));
  const dbPath = join(root, "old.sqlite");
  const old = await openDatabase({ dbPath, migrationsDir: migrations, backupDir: join(root, "backups") });
  const source = randomUUID(), version = randomUUID(), one = randomUUID(), two = randomUUID(), chunk = randomUUID();
  const hash = "a".repeat(64);
  const time = "2026-10-20T00:00:00.000Z";
  const locator = { schemaVersion: 1, kind: "markdown", line: 5, column: 1, ordinal: 0, rawTarget: "logo.png", normalizedRelativePath: "logo.png", resolution: "missing" };
  old.db.prepare("INSERT INTO blobs VALUES(?,?,?,8,?)").run(hash, "snapshot", "text/markdown", time);
  old.db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,'active',?,?)").run(source, "local_markdown", "same-source", "notes", null, time, time);
  old.db.prepare("INSERT INTO source_versions VALUES(?,?,?,?,NULL,?,?)").run(version, source, hash, hash, time, time);
  const insert = old.db.prepare("INSERT INTO occurrences(id,source_version_id,asset_id,locator_json,occurrence_index,heading_path,before_text,after_text,media_status,version,created_at,updated_at,media_error_code) VALUES(?,?,NULL,?,0,'章','before','after','missing',0,?,?,NULL)");
  insert.run(one, version, JSON.stringify(locator), time, time);
  insert.run(two, version, JSON.stringify({ ...locator, resolution: "inside_root" }), "2026-10-21T00:00:00.000Z", time);
  old.db.prepare("INSERT INTO chunks VALUES(?,?,?,'retained','context','{}',?,?)").run(chunk, version, two, hash, time);
  const snapshot = old.db.prepare(
    "SELECT id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at FROM source_versions",
  ).all();
  const locators = old.db.prepare("SELECT id,locator_json FROM occurrences ORDER BY id").all();
  expect(old.info.migrationCount).toBe(2);
  old.db.close();
  const upgraded = await openDatabase({ dbPath, backupDir: join(root, "backups") });
  try {
    expect(upgraded.appliedMigrations).toEqual([
      "003_t02_import_invariants",
      "004_t02c_asset_map_and_source_list",
      "005_t06_authoring_core",
      "006_t06_provider_journal",
      "007_t03_t04_document_search",
      "008_t05_template_validation",
      "009_t07_outputs",
    ]);
    expect(upgraded.backupPath).not.toBeNull();
    expect(upgraded.db.prepare(
      "SELECT id, source_id, fingerprint, snapshot_blob_hash, remote_revision, captured_at, created_at FROM source_versions",
    ).all()).toEqual(snapshot);
    expect(upgraded.db.prepare("SELECT id,locator_json FROM occurrences ORDER BY id").all()).toEqual(locators);
    expect(upgraded.db.prepare("SELECT id FROM canonical_occurrences").all()).toEqual([{ id: one }]);
    expect(upgraded.db.prepare("SELECT canonical_id FROM occurrences WHERE id=?").get(two)).toEqual({ canonical_id: one });
    expect(upgraded.db.prepare("SELECT occurrence_id FROM chunks WHERE id=?").get(chunk)).toEqual({ occurrence_id: two });
    expect(upgraded.db.pragma("foreign_key_check")).toEqual([]);
    expect(upgraded.db.pragma("integrity_check", { simple: true })).toBe("ok");
  }
  finally {
    upgraded.db.close();
  }
});
