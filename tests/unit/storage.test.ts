import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlobHashMismatchError,
  BlobStore,
  DatabaseMigrationError,
  openDatabase,
} from "@dmall/storage";
import { z } from "zod";

const temporaryRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dcw-storage-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content-addressed blob store", () => {
  it("streams, verifies and deduplicates bytes", async () => {
    const root = await tempRoot();
    const store = new BlobStore(root);
    const bytes = Buffer.from("streamed-content");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const first = await store.putStream({
      source: (async function* () {
        yield bytes.subarray(0, 4);
        yield bytes.subarray(4);
      })(),
      expectedSha256: hash,
      mime: "text/plain",
    });
    const second = await store.putBytes({ bytes, expectedSha256: hash });
    expect(first.sha256).toBe(hash);
    expect(second.deduped).toBe(true);
    expect(await store.verify(hash)).toBe(true);
    expect((await store.describe(hash))?.bytes).toBe(bytes.length);
  });

  it("does not publish bytes with a mismatched hash", async () => {
    const root = await tempRoot();
    const store = new BlobStore(root);
    const wrong = "0".repeat(64);
    await expect(store.putBytes({ bytes: Buffer.from("bad"), expectedSha256: wrong })).rejects.toBeInstanceOf(
      BlobHashMismatchError,
    );
    expect(await store.describe(wrong)).toBeNull();
  });
});

describe("SQLite migrations", () => {
  it("enables WAL, foreign keys and busy timeout and installs core tables", async () => {
    const root = await tempRoot();
    const result = await openDatabase({
      dbPath: join(root, "db", "workbench.sqlite"),
      backupDir: join(root, "backups"),
    });
    try {
      expect(result.info).toMatchObject({
        journalMode: "wal",
        foreignKeys: true,
        busyTimeoutMs: 5_000,
        migrationCount: 10,
      });
      const tables = z
        .array(z.strictObject({ name: z.string() }))
        .parse(result.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
        .map((row) => row.name);
      for (const table of [
        "contents",
        "renditions",
        "revisions",
        "jobs",
        "job_events",
        "remote_operations",
        "idempotency_keys",
        "local_sessions",
        "import_scans",
        "asset_map_entries",
        "scan_items",
        "upload_sessions",
        "upload_chunks",
        "import_items",
      ]) {
        expect(tables).toContain(table);
      }
      expect(() =>
        result.db
          .prepare(
            "INSERT INTO renditions (id, content_id, kind, label, root_node_id, version, created_at, updated_at) VALUES (?, ?, 'feishu_doc', 'x', ?, 0, ?, ?)",
          )
          .run(randomUUID(), "missing", randomUUID(), new Date().toISOString(), new Date().toISOString()),
      ).toThrow();
    } finally {
      result.db.close();
    }
  });

  it("backs up an existing database and keeps the old database when a migration fails", async () => {
    const root = await tempRoot();
    const dbDir = join(root, "db");
    const dbPath = join(dbDir, "workbench.sqlite");
    const valid = await openDatabase({ dbPath, backupDir: join(root, "backups") });
    valid.db.prepare("INSERT INTO tags (id, name, normalized_name, created_at) VALUES (?, '旧值', '旧值', ?)").run(
      randomUUID(),
      new Date().toISOString(),
    );
    valid.db.close();

    const migrationDir = join(root, "migrations");
    await mkdir(migrationDir, { recursive: true });
    const initial = await readFile(new URL("../../packages/storage/migrations/001_initial.sql", import.meta.url), "utf8");
    await writeFile(join(migrationDir, "001_initial.sql"), initial);
    await writeFile(join(migrationDir, "002_broken.sql"), "THIS IS NOT VALID SQL;");
    await expect(
      openDatabase({
        dbPath,
        backupDir: join(root, "backups"),
        migrationsDir: migrationDir,
      }),
    ).rejects.toBeInstanceOf(DatabaseMigrationError);
    const reopened = await openDatabase({ dbPath, backupDir: join(root, "backups") });
    try {
      const rows = z
        .array(z.strictObject({ name: z.string() }))
        .parse(reopened.db.prepare("SELECT name FROM tags").all());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("旧值");
    } finally {
      reopened.db.close();
    }
    expect(await readdirSafe(join(root, "backups"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^pre-migration-.*\.sqlite$/)]),
    );
  });

  it("rejects updates to immutable revisions", async () => {
    const root = await tempRoot();
    const result = await openDatabase({
      dbPath: join(root, "db", "workbench.sqlite"),
      backupDir: join(root, "backups"),
    });
    try {
      const now = new Date().toISOString();
      const contentId = randomUUID();
      const renditionId = randomUUID();
      const revisionId = randomUUID();
      result.db
        .prepare(
          `INSERT INTO contents (id, title, brief_json, status, version, created_at, updated_at)
           VALUES (?, '内容', '{}', 'draft', 0, ?, ?)`,
        )
        .run(contentId, now, now);
      result.db
        .prepare(
          `INSERT INTO renditions
            (id, content_id, kind, label, root_node_id, current_revision_id, version, created_at, updated_at)
           VALUES (?, ?, 'feishu_doc', '主版本', ?, NULL, 0, ?, ?)`,
        )
        .run(renditionId, contentId, randomUUID(), now, now);
      result.db
        .prepare(
          `INSERT INTO revisions
            (id, rendition_id, ast_json, created_by, reason, created_at)
           VALUES (?, ?, '{}', 'user', '初始', ?)`,
        )
        .run(revisionId, renditionId, now);
      expect(() =>
        result.db.prepare("UPDATE revisions SET reason = '改写' WHERE id = ?").run(revisionId),
      ).toThrow(/immutable/);
    } finally {
      result.db.close();
    }
  });
});

async function readdirSafe(path: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(path);
  } catch {
    return [];
  }
}
