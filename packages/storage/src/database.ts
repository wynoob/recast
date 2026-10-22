import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";

const MigrationFileSchema = z.string().regex(/^\d{3}_[a-z0-9_-]+\.sql$/);
const MigrationRowSchema = z.strictObject({
  version: z.string(),
});

export interface OpenDatabaseOptions {
  dbPath: string;
  backupDir?: string;
  migrationsDir?: string;
  busyTimeoutMs?: number;
}

export interface DatabaseRuntimeInfo {
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  migrationCount: number;
}

export interface OpenDatabaseResult {
  db: Database.Database;
  info: DatabaseRuntimeInfo;
  backupPath: string | null;
  appliedMigrations: string[];
}

export class DatabaseMigrationError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "DatabaseMigrationError";
    this.cause = cause;
  }
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<OpenDatabaseResult> {
  const dbPath = resolve(options.dbPath);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const backupDir = options.backupDir ?? join(dirname(dbPath), "..", "backups");
  await mkdir(dirname(dbPath), { recursive: true });
  await mkdir(backupDir, { recursive: true });

  const db = new Database(dbPath);
  let backupPath: string | null = null;

  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);

    const userTableCount = countUserTables(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const migrationFiles = await readMigrationFiles(migrationsDir);
    const applied = appliedMigrations(db);
    const pending = migrationFiles.filter((file) => !applied.has(migrationVersion(file)));

    if (pending.length > 0 && (userTableCount > 0 || applied.size > 0)) {
      backupPath = await createOnlineBackup(db, backupDir);
    }

    if (pending.length > 0) {
      applyPendingMigrations(db, pending, migrationsDir);
    }

    const info = inspectDatabase(db, busyTimeoutMs);
    return {
      db,
      info,
      backupPath,
      appliedMigrations: pending.map(migrationVersion),
    };
  } catch (error) {
    db.close();
    if (error instanceof DatabaseMigrationError) throw error;
    throw new DatabaseMigrationError("数据库初始化或迁移失败", error);
  }
}

export function inspectDatabase(db: Database.Database, expectedBusyTimeoutMs = 5_000): DatabaseRuntimeInfo {
  const journal = db.pragma("journal_mode", { simple: true });
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  const busyTimeout = db.pragma("busy_timeout", { simple: true });
  const migrationCount = z
    .array(z.strictObject({ count: z.int().nonnegative() }))
    .parse(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").all())[0]?.count;
  return {
    journalMode: z.string().parse(journal).toLowerCase(),
    foreignKeys: z.number().parse(foreignKeys) === 1,
    busyTimeoutMs: busyTimeout === undefined ? expectedBusyTimeoutMs : z.number().parse(busyTimeout),
    migrationCount: migrationCount ?? 0,
  };
}

function countUserTables(db: Database.Database): number {
  const rows = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
    )
    .all();
  return z.array(z.strictObject({ count: z.int().nonnegative() })).parse(rows)[0]?.count ?? 0;
}

function appliedMigrations(db: Database.Database): Set<string> {
  const rows = z
    .array(MigrationRowSchema)
    .parse(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all());
  return new Set(rows.map((row) => row.version));
}

async function readMigrationFiles(migrationsDir: string): Promise<string[]> {
  const names = await readdir(migrationsDir);
  return names.filter((name) => MigrationFileSchema.safeParse(name).success).sort();
}

function migrationVersion(fileName: string): string {
  return fileName.replace(/\.sql$/u, "");
}

function applyPendingMigrations(
  db: Database.Database,
  pending: string[],
  migrationsDir: string,
): void {
  const insert = db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const file of pending) {
      const sql = requireText(join(migrationsDir, file));
      db.exec(sql);
      insert.run(migrationVersion(file), new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite may already have rolled back after a failed DDL statement.
    }
    throw new DatabaseMigrationError("迁移事务失败，数据库已回滚", error);
  }
}

function requireText(path: string): string {
  return readFileSync(path, "utf8");
}

async function createOnlineBackup(db: Database.Database, backupDir: string): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = join(backupDir, `pre-migration-${stamp}.sqlite`);
  await db.backup(backupPath);
  const checkDb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = z.string().parse(checkDb.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new Error(`备份完整性检查失败: ${integrity}`);
  } finally {
    checkDb.close();
  }
  const backupHash = await hashFile(backupPath);
  await writeFile(`${backupPath}.sha256`, `${backupHash}  ${backupPath.split("/").at(-1)}\n`, "utf8");
  return backupPath;
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../migrations/", import.meta.url));
}

export async function readMigrationSql(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
