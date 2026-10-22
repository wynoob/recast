import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp, type AppContext } from "../../apps/server/src/app.js";
import { JobGrantSchema } from "@dmall/contracts";
const active: AppContext[] = [];
afterEach(async () => { for (const app of active.splice(0))
  await app.app.close(); });
async function setup(workers = true) {
  const root = await mkdtemp(join(tmpdir(), "fix-api-"));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const addr = listener.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const app = await createApp({ startWorkers: workers, config: { host: "127.0.0.1", port, dataRoot: root, dbPath: join(root, "db.sqlite"), backupDir: join(root, "backups"), webRoot: join(root, "no-web"), workerPoolSize: 1, devOrigins: [] } });
  active.push(app);
  const base = await app.app.listen({ host: "127.0.0.1", port });
  const health = await fetch(base + "/api/v1/health");
  const setCookie = health.headers.get("set-cookie");
  if (setCookie === null)
    throw new Error("health missing cookie: " + await health.text());
  const cookie = setCookie.split(";")[0] ?? "";
  const csrf = (await health.json()).data.csrfToken;
  const headers = { cookie, "x-csrf-token": csrf, origin: base };
  async function json(path: string, body?: unknown, key = randomUUID()) {
    const r = await fetch(base + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await r.json();
    if (!r.ok)
      throw new Error(JSON.stringify(value));
    return value.data;
  }
  async function upload(bytes: Buffer, fields: Record<string, string>, key = randomUUID()) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields))
      form.set(key, value);
    form.set("chunkSha256", createHash("sha256").update(bytes).digest("hex"));
    form.set("file", new Blob([bytes]), "part.bin");
    const r = await fetch(base + "/api/v1/uploads", { method: "POST", headers: { ...headers, "idempotency-key": key }, body: form });
    return { status: r.status, body: await r.json() };
  }
  async function scan(path: string) { const c = await json("/imports/scan", { schemaVersion: 1, sourceKind: "local_directory", rootPath: path, options: { generatePreviews: true } }); await until(async () => { const s = await json(`/imports/scans/${c.scanId}`); return s.status === "ready" ? s : false; }); return c; }
  async function imported(scanId: string, include?: string[]) { const c = await json("/imports", { schemaVersion: 1, scanId, selection: { mode: include === undefined ? "all" : "explicit", includeItemIds: include ?? [], excludeItemIds: [] }, options: { generatePreviews: true, ocr: "blocked", allowExternalModel: false, allowFeishu: false } }); return until(async () => { const d = await json(`/imports/${c.importId}`); return ["succeeded", "partial", "failed", "cancelled"].includes(d.status) ? d : false; }); }
  return { root, app, json, upload, scan, imported };
}
async function until<T>(fn: () => Promise<T | false>, ms = 30000): Promise<T> { const end = Date.now() + ms; while (Date.now() < end) {
  const value = await fn();
  if (value !== false)
    return value;
  await new Promise(resolve => setTimeout(resolve, 20));
} throw new Error("condition timeout"); }
const firstFields = (size: number, count = 1) => ({ relativePath: "notes.md", declaredBytes: String(size), chunkIndex: "0", chunkCount: String(count) });
it("imports all 101 selected markdown files and derives success from final counts", async () => {
  const s = await setup();
  const fixture = join(s.root, "fixture");
  await mkdir(fixture);
  for (let i = 0; i < 101; i++)
    await writeFile(join(fixture, `${String(i).padStart(3, "0")}.md`), `# ${i}\n`);
  const scan = await s.scan(fixture);
  const detail = await s.imported(scan.scanId);
  expect(detail.status).toBe("succeeded");
  expect(detail.counts).toEqual({ pending: 0, committed: 101, failed: 0, skipped: 0, total: 101 });
  expect(s.app.database.db.prepare("SELECT count(*) AS count FROM source_versions").get()).toEqual({ count: 101 });
}, 60000);
it("refuses a scanned parent moved outside the root and symlinked back", async () => {
  const s = await setup();
  const fixture = join(s.root, "fixture");
  await mkdir(join(fixture, "sub"), { recursive: true });
  await writeFile(join(fixture, "sub/notes.md"), "# only here");
  const scan = await s.scan(fixture);
  await rename(join(fixture, "sub"), join(s.root, "moved"));
  await symlink(join(s.root, "moved"), join(fixture, "sub"));
  const d = await s.imported(scan.scanId);
  expect(d.counts.committed).toBe(0);
  expect(d.status).toBe("failed");
  expect(s.app.database.db.prepare("SELECT count(*) AS count FROM blobs").get()).toEqual({ count: 0 });
});
it("keeps the same occurrence ID when missing dependencies become selected", async () => {
  const s = await setup();
  const fixture = join(s.root, "fixture");
  await mkdir(join(fixture, "assets"), { recursive: true });
  await writeFile(join(fixture, "notes.md"), "# 章\n\n前文\n\n![图](assets/logo.png)\n\n后文");
  await copyFile(join(process.cwd(), "input/Dmall内容工作台-完整交接包-v1.0/materials/local/public/assets/brand/dmall-logo.png"), join(fixture, "assets/logo.png"));
  const scan = await s.scan(fixture);
  const items = await s.json(`/imports/scans/${scan.scanId}/items?limit=100`);
  const md = items.items.find((item: {
    relativePath: string;
  }) => item.relativePath === "notes.md");
  await s.imported(scan.scanId, [md.id]);
  const before = s.app.database.db.prepare("SELECT id,source_version_id,locator_json,before_text,after_text FROM occurrences WHERE json_extract(locator_json,'$.kind')='markdown'").get();
  const snapshot = s.app.database.db.prepare("SELECT id,snapshot_blob_hash FROM source_versions").all();
  const next = await s.scan(fixture);
  await s.imported(next.scanId);
  const after = s.app.database.db.prepare("SELECT id,source_version_id,locator_json,before_text,after_text FROM occurrences WHERE json_extract(locator_json,'$.kind')='markdown'").all();
  expect(after).toEqual([before]);
  expect(s.app.database.db.prepare("SELECT media_status FROM occurrences WHERE json_extract(locator_json,'$.kind')='markdown'").get()).toEqual({ media_status: "available" });
  for (const row of snapshot)
    expect(s.app.database.db.prepare("SELECT id,snapshot_blob_hash FROM source_versions WHERE id=?").get((row as {
      id: string;
    }).id)).toEqual(row);
});
it("rolls back first-block allocation and receipt together, then reuses the prepared logical identity", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# test\n");
  const key = randomUUID();
  s.app.database.db.exec("CREATE TRIGGER fault BEFORE INSERT ON idempotency_keys BEGIN SELECT RAISE(ABORT,'receipt fault'); END");
  const failed = await s.upload(bytes, firstFields(bytes.length), key);
  expect(failed.status).toBe(500);
  expect(s.app.database.db.prepare("SELECT count(*) AS n FROM upload_sessions").get()).toEqual({ n: 0 });
  expect(s.app.database.db.prepare("SELECT count(*) AS n FROM upload_chunks").get()).toEqual({ n: 0 });
  const prepared = (await readdir(join(s.root, "staging/uploads"))).filter(path => !path.startsWith("incoming-"));
  expect(prepared).toHaveLength(1);
  s.app.database.db.exec("DROP TRIGGER fault");
  const retry = await s.upload(bytes, firstFields(bytes.length), key);
  expect(retry.status).toBe(201);
  expect(retry.body.data.fileId).toBe(prepared[0]);
  expect(retry.body.data.complete).toBe(true);
  const replay = await s.upload(bytes, firstFields(bytes.length), key);
  expect(replay.body.data).toEqual(retry.body.data);
  expect(s.app.database.db.prepare("SELECT count(*) AS n FROM upload_sessions").get()).toEqual({ n: 1 });
});
it("rolls back last-block count and completion on receipt failure and replays the full result", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# hello\n");
  const first = await s.upload(bytes.subarray(0, 2), firstFields(bytes.length, 2));
  expect(first.status).toBe(201);
  const fields = { fileId: first.body.data.fileId, chunkIndex: "1", chunkCount: "2" };
  const key = randomUUID();
  s.app.database.db.exec("CREATE TRIGGER fault BEFORE INSERT ON idempotency_keys BEGIN SELECT RAISE(ABORT,'receipt fault'); END");
  expect((await s.upload(bytes.subarray(2), fields, key)).status).toBe(500);
  expect(s.app.database.db.prepare("SELECT status,next_chunk,received_bytes FROM upload_sessions").get()).toEqual({ status: "uploading", next_chunk: 1, received_bytes: 2 });
  expect(s.app.database.db.prepare("SELECT count(*) AS n FROM upload_chunks").get()).toEqual({ n: 1 });
  s.app.database.db.exec("DROP TRIGGER fault");
  const retry = await s.upload(bytes.subarray(2), fields, key);
  expect(retry.status).toBe(201);
  expect(retry.body.data).toMatchObject({ fileId: fields.fileId, complete: true, bytes: bytes.length, nextChunk: 2, sha256: createHash("sha256").update(bytes).digest("hex") });
  expect((await s.upload(bytes.subarray(2), fields, key)).body.data).toEqual(retry.body.data);
});
it("rejects a 2048-byte first block declared as one byte before committing any session or block", async () => {
  const s = await setup(false);
  const r = await s.upload(Buffer.alloc(2048), firstFields(1, 65536));
  expect(r.status).toBe(413);
  expect(s.app.database.db.prepare("SELECT count(*) AS n FROM upload_sessions").get()).toEqual({ n: 0 });
  expect(s.app.database.db.prepare("SELECT count(*) AS n FROM upload_chunks").get()).toEqual({ n: 0 });
  expect(await readdir(join(s.root, "staging/uploads"))).toEqual([]);
});
it("serializes concurrent final chunks, does not double count, and rejects a different chunk hash", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# 12345\n");
  const first = await s.upload(bytes.subarray(0, 2), firstFields(bytes.length, 2));
  const fields = { fileId: first.body.data.fileId, chunkIndex: "1", chunkCount: "2" };
  const results = await Promise.all([s.upload(bytes.subarray(2), fields), s.upload(bytes.subarray(2), fields)]);
  expect(results.map(r => r.status)).toEqual([201, 201]);
  expect(results[0]!.body.data).toEqual(results[1]!.body.data);
  expect(s.app.database.db.prepare("SELECT received_bytes,next_chunk FROM upload_sessions").get()).toEqual({ received_bytes: bytes.length, next_chunk: 2 });
  expect((await s.upload(Buffer.from("different"), fields)).status).toBe(409);
});
it("allows two new scans of the same complete upload IDs without rebinding the first scan", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# test\n");
  const file = await s.upload(bytes, firstFields(bytes.length));
  const body = { schemaVersion: 1, sourceKind: "upload", fileIds: [file.body.data.fileId], options: { generatePreviews: true } };
  const a = await s.json("/imports/scan", body);
  const b = await s.json("/imports/scan", body);
  expect(a.scanId).not.toBe(b.scanId);
  expect(s.app.imports.repository.uploadSessionsForScan(a.scanId).map(x => x.id)).toEqual([file.body.data.fileId]);
  expect(s.app.imports.repository.uploadSessionsForScan(b.scanId).map(x => x.id)).toEqual([file.body.data.fileId]);
});
it("shares UTF8 window handling between uploads and directories and rejects invalid EOF", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# " + "中".repeat(30000));
  const ok = await s.upload(bytes, firstFields(bytes.length));
  expect(ok.status).toBe(201);
  expect(ok.body.data.magicKind).toBe("markdown");
  const bad = Buffer.from([35, 32, 0xe4, 0xb8]);
  expect((await s.upload(bad, firstFields(bad.length))).status).toBe(422);
});
it("settles real prepareGrant EISDIR failures into the same failed scan, job and persisted error event", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# test\n");
  const file = await s.upload(bytes, firstFields(bytes.length));
  const scan = await s.json("/imports/scan", { schemaVersion: 1, sourceKind: "upload", fileIds: [file.body.data.fileId], options: { generatePreviews: true } });
  for (let attempt = 1; attempt <= 3; attempt++)
    await mkdir(join(s.root, "staging/jobs", scan.jobId, `${attempt}-${attempt}`, "input-manifest.json"), { recursive: true });
  await s.app.scheduler.start();
  await until(async () => s.app.jobs.snapshotById(scan.jobId).state === "failed");
  expect(s.app.imports.getScanDetail(scan.scanId).status).toBe("failed");
  const events = s.app.jobs.events(scan.jobId, 0);
  expect(events.at(-1)?.kind).toBe("error");
  expect(s.app.jobs.snapshotById(scan.jobId).attempt).toBe(3);
});
it("atomically settles cancellation and budget exhaustion before publishing terminal events", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# test\n");
  const f = await s.upload(bytes, firstFields(bytes.length));
  const scan = await s.json("/imports/scan", { schemaVersion: 1, sourceKind: "upload", fileIds: [f.body.data.fileId], options: { generatePreviews: true } });
  s.app.database.db.exec("CREATE TRIGGER event_fault BEFORE INSERT ON job_events BEGIN SELECT RAISE(ABORT,'event fault'); END");
  expect(() => s.app.scheduler.requestCancel(s.app.jobs.snapshotById(scan.jobId))).toThrow("event fault");
  expect(s.app.jobs.snapshotById(scan.jobId).state).toBe("queued");
  expect(s.app.imports.getScanDetail(scan.scanId).status).toBe("queued");
  s.app.database.db.exec("DROP TRIGGER event_fault");
  s.app.scheduler.requestCancel(s.app.jobs.snapshotById(scan.jobId));
  expect(s.app.imports.getScanDetail(scan.scanId).status).toBe("cancelled");
});
it("rejects results from a previous generation after recovery", async () => {
  const s = await setup(false);
  const f = await s.upload(Buffer.from("# a\n"), firstFields(4));
  const scan = await s.json("/imports/scan", { schemaVersion: 1, sourceKind: "upload", fileIds: [f.body.data.fileId], options: { generatePreviews: true } });
  const old = JobGrantSchema.parse(s.app.jobs.assign(scan.jobId, "owner").grant);
  s.app.jobs.requeueAfterWorkerExit(scan.jobId);
  s.app.jobs.assign(scan.jobId, "new-owner");
  expect(s.app.jobs.finish({ fence: old.fence, state: "failed", result: null, error: { code: "INTERNAL_ERROR", message: "old", retryable: false } })).toBeNull();
  expect(s.app.jobs.snapshotById(scan.jobId).state).toBe("running");
});
it("settles unfinished import items before choosing failed or partial, including rollback and exhausted leases", async () => {
  const s = await setup();
  const fixture = join(s.root, "fixture");
  await mkdir(fixture);
  await writeFile(join(fixture, "a.md"), "# a");
  await writeFile(join(fixture, "b.md"), "# b");
  const scan = await s.scan(fixture);
  await s.app.scheduler.close();
  const created = await s.json("/imports", { schemaVersion: 1, scanId: scan.scanId, selection: { mode: "all", includeItemIds: [], excludeItemIds: [] }, options: { generatePreviews: true, ocr: "blocked", allowExternalModel: false, allowFeishu: false } });
  const grant = JobGrantSchema.parse(s.app.jobs.assign(created.jobId, "manual").grant);
  const items = s.app.imports.repository.executionItems(created.jobId);
  s.app.imports.repository.setImportItemState({ id: items[0]!.id, state: "committed" });
  const input = { fence: grant.fence, state: "succeeded" as const, result: { schemaVersion: 1 as const, jobType: "local_import" as const, importId: created.jobId, committed: 1, skipped: 0, failed: 0, assetIds: [] }, error: null };
  s.app.database.db.exec("CREATE TRIGGER terminal_fault BEFORE INSERT ON job_events BEGIN SELECT RAISE(ABORT,'terminal fault'); END");
  expect(() => s.app.jobs.finish(input)).toThrow("terminal fault");
  expect(s.app.jobs.snapshotById(created.jobId).state).toBe("running");
  expect(s.app.imports.repository.importCounts(created.jobId).pending).toBe(1);
  s.app.database.db.exec("DROP TRIGGER terminal_fault");
  s.app.jobs.finish(input);
  const done = s.app.jobs.snapshotById(created.jobId);
  expect(done.state).toBe("partial");
  expect(s.app.imports.repository.importCounts(created.jobId)).toMatchObject({ pending: 0, committed: 1, failed: 1 });
  const scan2 = await s.json("/imports/scan", { schemaVersion: 1, sourceKind: "local_directory", rootPath: fixture, options: { generatePreviews: true } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    s.app.jobs.assign(scan2.jobId, `owner-${attempt}`);
    s.app.jobs.requeueAfterWorkerExit(scan2.jobId);
  }
  expect(s.app.jobs.snapshotById(scan2.jobId).state).toBe("failed");
  expect(s.app.imports.getScanDetail(scan2.scanId).status).toBe("failed");
  expect(s.app.jobs.events(scan2.jobId, 0).at(-1)?.kind).toBe("error");
});

it("keeps repeated blocks uncounted and enforces the remaining declared and 2GiB budget during streaming", async () => {
  const s = await setup(false);
  const first = await s.upload(Buffer.from("# "), firstFields(3, 3));
  expect(first.status).toBe(201);
  const duplicate = await s.upload(Buffer.from("# "), { fileId: first.body.data.fileId, chunkIndex: "0", chunkCount: "3" });
  expect(duplicate.body.data.receivedBytes).toBe(2);
  const tooMuch = await s.upload(Buffer.alloc(2048), { fileId: first.body.data.fileId, chunkIndex: "1", chunkCount: "3" });
  expect(tooMuch.status).toBe(413);
  expect(s.app.database.db.prepare("SELECT received_bytes,next_chunk FROM upload_sessions").get()).toEqual({ received_bytes: 2, next_chunk: 1 });
  s.app.database.db.prepare("UPDATE upload_sessions SET declared_bytes=2147483648,received_bytes=2147483647 WHERE id=?").run(first.body.data.fileId);
  const atLimit = await s.upload(Buffer.from("ab"), { fileId: first.body.data.fileId, chunkIndex: "1", chunkCount: "3" });
  expect(atLimit.status).toBe(413);
  expect(s.app.database.db.prepare("SELECT count(*) AS n FROM upload_chunks").get()).toEqual({ n: 1 });
});

it("settles exhausted and cancelled import items atomically and publishes only committed terminal states", async () => {
  const s = await setup();
  const fixture = join(s.root, "fixture");
  await mkdir(fixture);
  await writeFile(join(fixture, "a.md"), "# a");
  await writeFile(join(fixture, "b.md"), "# b");
  const scan = await s.scan(fixture);
  await s.app.scheduler.close();
  const created = await s.json("/imports", { schemaVersion: 1, scanId: scan.scanId, selection: { mode: "all", includeItemIds: [], excludeItemIds: [] }, options: { generatePreviews: true, ocr: "blocked", allowExternalModel: false, allowFeishu: false } });
  const input = s.app.jobs.get(created.jobId)?.input;
  if (input?.jobType !== "local_import") throw new Error("missing import input");
  for (const mode of ["exhausted", "cancelled"] as const) {
    const id = randomUUID();
    s.app.jobs.create({ id, type: "local_import", input: { ...input, importId: id }, inputHash: "0".repeat(64), idempotencyKey: randomUUID() });
    s.app.imports.repository.createImportItems(id, s.app.imports.repository.candidateScanItems(scan.scanId));
    const items = s.app.imports.repository.executionItems(id);
    s.app.imports.repository.setImportItemState({ id: items[0]!.id, state: "committed" });
    let published = 0;
    const unsubscribe = s.app.events.subscribe(id, event => {
      if (event.kind === "completed") {
        published += 1;
        expect(s.app.jobs.snapshotById(id).state).toBe("cancelled");
        expect(s.app.imports.repository.importCounts(id).pending).toBe(0);
        expect(s.app.jobs.events(id, 0).at(-1)?.seq).toBe(event.seq);
      }
    });
    if (mode === "exhausted") {
      for (let attempt = 1; attempt <= 3; attempt++) {
        s.app.jobs.assign(id, `owner-${attempt}`);
        s.app.jobs.requeueAfterWorkerExit(id);
      }
      expect(s.app.jobs.snapshotById(id).state).toBe("partial");
      expect(s.app.imports.repository.importCounts(id)).toMatchObject({ pending: 0, committed: 1, failed: 1 });
      expect(s.app.jobs.events(id, 0).at(-1)?.payload).toMatchObject({ kind: "completed", state: "partial" });
    } else {
      s.app.scheduler.requestCancel(s.app.jobs.snapshotById(id));
      expect(s.app.imports.repository.importCounts(id)).toMatchObject({ pending: 0, committed: 1, skipped: 1 });
      expect(published).toBe(1);
    }
    unsubscribe();
  }
});

it("preserves the completed upload file identity when the final block is repeated under a new key", async () => {
  const s = await setup(false);
  const bytes = Buffer.from("# stable\n");
  const uploaded = await s.upload(bytes, firstFields(bytes.length));
  const id = uploaded.body.data.fileId;
  const file = join(s.root, "staging/uploads", id, "file");
  const before = await stat(file);
  const repeated = await s.upload(bytes, { fileId: id, chunkIndex: "0", chunkCount: "1" });
  const after = await stat(file);
  expect(repeated.body.data).toEqual(uploaded.body.data);
  expect({ inode: after.ino, mtime: after.mtimeMs }).toEqual({ inode: before.ino, mtime: before.mtimeMs });
});
