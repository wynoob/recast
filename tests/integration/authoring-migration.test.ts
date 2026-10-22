import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@dmall/storage";

const roots: string[] = [];
const expectedHashes: Record<string, string> = {
  "001_initial.sql": "e5819f68d576d7e2d61cabd64506ac83cddaeaa5103a3dc43636bf04c5c7b33f",
  "002_t02_local_import.sql": "fe8d25e72fbdd19959d2908db04389b15051a5b879a0b1de3a705c9481af17a2",
  "003_t02_import_invariants.sql": "0487fd7be2090e2e7ef8b991ff3bfb34146239eebb2d870f836f5a1bbd43cdd1",
  "004_t02c_asset_map_and_source_list.sql": "61da38729a8f08d0ed6ca8aaccb792d27527ebd673c66f44e1183d5d72992480",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T06 authoring migration 005 and T05 migration 008", () => {
  it("applies both migrations and creates authoring core plus template validation tables", async () => {
    const root = await tempRoot("dcw-t06-fresh-");
    const opened = await openDatabase({
      dbPath: join(root, "db", "workbench.sqlite"),
      backupDir: join(root, "backups"),
    });
    try {
      expect(opened.appliedMigrations).toEqual([
        "001_initial",
        "002_t02_local_import",
        "003_t02_import_invariants",
        "004_t02c_asset_map_and_source_list",
        "005_t06_authoring_core",
        "006_t06_provider_journal",
        "007_t03_t04_document_search",
        "008_t05_template_validation",
        "009_t07_outputs",
      ]);
      expect(opened.info.migrationCount).toBe(9);
      const tables = opened.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all().map((row) => String((row as { name: string }).name));
      expect(tables).toEqual(expect.arrayContaining([
        "authoring_confirmations",
        "generation_inputs",
        "revision_evidence",
        "worker_receipts",
      ]));
      expect(opened.db.pragma("foreign_key_check")).toEqual([]);
      expect(opened.db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      opened.db.close();
    }
  });

  it("keeps 001-004 byte-identical", async () => {
    for (const [name, expected] of Object.entries(expectedHashes)) {
      const bytes = await readFile(join(process.cwd(), "packages/storage/migrations", name));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
  });

  it("upgrades a pre-005 database and backfills only provable empty revisions", async () => {
    const root = await tempRoot("dcw-t06-upgrade-");
    const oldMigrations = join(root, "migrations-004");
    await mkdir(oldMigrations);
    for (const name of Object.keys(expectedHashes)) {
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
    const seeded = seedRevisionHistory(old.db);
    old.db.close();

    const upgraded = await openDatabase({ dbPath, backupDir: join(root, "backups") });
    try {
      expect(upgraded.appliedMigrations).toEqual([
        "005_t06_authoring_core",
        "006_t06_provider_journal",
        "007_t03_t04_document_search",
        "008_t05_template_validation",
        "009_t07_outputs",
      ]);
      expect(upgraded.backupPath).not.toBeNull();
      const rows = upgraded.db.prepare(
        "SELECT revision_id, binding_hash FROM revision_evidence ORDER BY revision_id",
      ).all();
      expect(rows).toEqual([{
        revision_id: seeded.emptyRevisionId,
        binding_hash: "5c00daa83b222b01e61d7b1f67756be84f4694acc080d0d0aaf44c42435558ad",
      }]);
      expect(upgraded.db.prepare(
        "SELECT COUNT(*) AS count FROM revision_evidence WHERE revision_id = ?",
      ).get(seeded.nonEmptyRevisionId)).toEqual({ count: 0 });
      expect(upgraded.db.pragma("foreign_key_check")).toEqual([]);
      expect(upgraded.db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      upgraded.db.close();
    }
  });

  it("enforces revision_evidence immutability and foreign keys", async () => {
    const root = await tempRoot("dcw-t06-evidence-constraints-");
    const opened = await openDatabase({
      dbPath: join(root, "db", "workbench.sqlite"),
      backupDir: join(root, "backups"),
    });
    try {
      const seeded = seedRevisionHistory(opened.db);
      const now = new Date().toISOString();
      const revisionId = randomUUID();
      const contentId = randomUUID();
      const renditionId = randomUUID();
      opened.db.prepare(
        "INSERT INTO contents(id, title, brief_json, merchant_id, status, version, created_at, updated_at) VALUES (?, 'x', '{}', NULL, 'draft', 0, ?, ?)",
      ).run(contentId, now, now);
      opened.db.prepare(
        "INSERT INTO renditions(id, content_id, kind, label, root_node_id, version, created_at, updated_at) VALUES (?, ?, 'feishu_doc', 'x', ?, 0, ?, ?)",
      ).run(renditionId, contentId, randomUUID(), now, now);
      opened.db.prepare(
        "INSERT INTO revisions(id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at) VALUES (?, ?, NULL, NULL, '{}', 'user', 'x', ?)",
      ).run(revisionId, renditionId, now);
      expect(() => opened.db.prepare(
        `INSERT INTO revision_evidence(
           revision_id, schema_version, direct_refs_json, transitive_refs_json,
           blob_hashes_json, bindings_json, binding_hash, created_at
         ) VALUES (?, 1, '[]', '[]', '[]', '[]', ?, ?)`,
      ).run(revisionId, "a".repeat(64), now)).not.toThrow();
      expect(() => opened.db.prepare(
        "UPDATE revision_evidence SET binding_hash = ? WHERE revision_id = ?",
      ).run("b".repeat(64), revisionId)).toThrow(/immutable/u);
      expect(() => opened.db.prepare(
        "DELETE FROM revision_evidence WHERE revision_id = ?",
      ).run(revisionId)).toThrow(/immutable/u);
      expect(() => opened.db.prepare(
        `INSERT INTO revision_evidence(
           revision_id, schema_version, direct_refs_json, transitive_refs_json,
           blob_hashes_json, bindings_json, binding_hash, created_at
         ) VALUES (?, 1, '[]', '[]', '[]', '[]', ?, ?)`,
      ).run(randomUUID(), "c".repeat(64), now)).toThrow();
      expect(seeded.emptyRevisionId).toMatch(/^[0-9a-f-]{36}$/u);
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

function seedRevisionHistory(db: import("better-sqlite3").Database): {
  emptyRevisionId: string;
  nonEmptyRevisionId: string;
} {
  const now = new Date().toISOString();
  const contentId = randomUUID();
  const renditionId = randomUUID();
  const emptyRevisionId = randomUUID();
  const nonEmptyRevisionId = randomUUID();
  db.prepare(
    "INSERT INTO contents(id, title, brief_json, merchant_id, status, version, created_at, updated_at) VALUES (?, '历史', '{}', NULL, 'draft', 0, ?, ?)",
  ).run(contentId, now, now);
  db.prepare(
    "INSERT INTO renditions(id, content_id, kind, label, root_node_id, current_revision_id, version, created_at, updated_at) VALUES (?, ?, 'feishu_doc', '主版本', ?, NULL, 0, ?, ?)",
  ).run(renditionId, contentId, randomUUID(), now, now);
  db.prepare(
    "INSERT INTO revisions(id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at) VALUES (?, ?, NULL, NULL, ?, 'user', '空稿', ?)",
  ).run(
    emptyRevisionId,
    renditionId,
    JSON.stringify({
      schemaVersion: 1,
      kind: "feishu_doc",
      title: "空稿",
      locks: [],
      sections: [],
      speakerNotes: {},
    }),
    now,
  );
  db.prepare(
    "INSERT INTO revisions(id, rendition_id, parent_id, template_version_id, ast_json, created_by, reason, created_at) VALUES (?, ?, NULL, NULL, ?, 'user', '非空历史', ?)",
  ).run(
    nonEmptyRevisionId,
    renditionId,
    JSON.stringify({
      schemaVersion: 1,
      kind: "feishu_doc",
      title: "非空历史",
      locks: [],
      sections: [{
        id: randomUUID(),
        title: "章节",
        locks: [],
        blocks: [{
          id: randomUUID(),
          type: "paragraph",
          inlines: [{ text: "历史正文", marks: [] }],
          provenance: [],
          locks: [],
        }],
      }],
      speakerNotes: {},
    }),
    now,
  );
  db.prepare("UPDATE renditions SET current_revision_id = ? WHERE id = ?")
    .run(emptyRevisionId, renditionId);
  return { emptyRevisionId, nonEmptyRevisionId };
}
