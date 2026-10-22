import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../../apps/server/src/app.js";
import type { RuntimeConfig } from "../../apps/server/src/config.js";

const INPUT_ROOT = join(
  process.cwd(),
  "input/Dmall内容工作台-完整交接包-v1.0/materials/local",
);

describe("T02a local import API", () => {
  let context: AppContext;
  let base: string;
  let cookie: string;
  let csrf: string;
  let fixtureRoot: string;
  let originalPng: Buffer;
  let scanId: string;
  let importId: string;
  let assetId: string;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "dcw-t02a-fixture-"));
    await mkdir(join(fixtureRoot, "assets"), { recursive: true });
    await copyFile(
      join(INPUT_ROOT, "public/assets/brand/dmall-logo.png"),
      join(fixtureRoot, "assets/logo.png"),
    );
    const gif = join(INPUT_ROOT, "public/assets/reference");
    const firstGif = (await readdir(gif)).filter((name) => name.endsWith(".gif")).sort()[0];
    if (firstGif === undefined) throw new Error("fixture gif missing");
    await copyFile(join(gif, firstGif), join(fixtureRoot, "assets/anim.gif"));
    await copyFile(
      join(INPUT_ROOT, "public/assets/素材-昨日销量情况.mp4"),
      join(fixtureRoot, "assets/demo.mp4"),
    );
    await writeFile(
      join(fixtureRoot, "docs.md"),
      [
        "# 测试章节",
        "",
        "第一段。",
        "",
        "第二段。",
        "",
        "![缺图](./missing.png)",
        "",
        "![已有图](assets/logo.png)",
        "",
        "第三段。",
        "",
        "![外链](https://example.com/a.png)",
        "",
      ].join("\n"),
    );
    originalPng = await readFile(join(fixtureRoot, "assets/logo.png"));

    const port = await freePort();
    const dataRoot = await mkdtemp(join(tmpdir(), "dcw-t02a-data-"));
    const config: RuntimeConfig = {
      host: "127.0.0.1",
      port,
      dataRoot,
      dbPath: join(dataRoot, "db", "workbench.sqlite"),
      backupDir: join(dataRoot, "backups"),
      webRoot: join(dataRoot, "no-web"),
      workerPoolSize: 2,
      devOrigins: [],
    };
    context = await createApp({ config });
    await context.app.listen({ host: "127.0.0.1", port });
    base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/v1/health`);
    const setCookie = health.headers.get("set-cookie");
    if (setCookie === null) throw new Error("missing session cookie");
    cookie = setCookie.split(";")[0] ?? "";
    const body = (await health.json()) as { data: { csrfToken: string } };
    csrf = body.data.csrfToken;
  }, 30_000);

  afterAll(async () => {
    await context?.app.close();
  });

  it("scans without copying, then imports real media and markdown occurrences", async () => {
    const created = await writeJson("POST", "/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: fixtureRoot,
      options: { generatePreviews: true },
    });
    scanId = (created as { data: { scanId: string } }).data.scanId;
    const scan = await waitScan(scanId, (value) => value.status === "ready");
    expect(scan.counts).toMatchObject({
      candidate: 4,
      mp4: 1,
      gif: 1,
      image: 1,
      markdown: 1,
    });
    expect(
      context.database.db.prepare("SELECT COUNT(*) AS count FROM blobs").get(),
    ).toEqual({ count: 0 });

    const imported = await writeJson("POST", "/api/v1/imports", {
      schemaVersion: 1,
      scanId,
      selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
    });
    importId = (imported as { data: { importId: string } }).data.importId;
    const detail = await waitImport(importId, (value) => ["succeeded", "partial", "failed"].includes(value.status));
    expect(detail.status).toBe("succeeded");
    expect(detail.counts).toMatchObject({ committed: 4, failed: 0 });

    const eventResponse = await fetch(`${base}/api/v1/jobs/${importId}/events`, {
      headers: { cookie },
    });
    expect(eventResponse.status).toBe(200);
    const reader = eventResponse.body?.getReader();
    if (reader === undefined) throw new Error("SSE body missing");
    const decoder = new TextDecoder();
    let eventText = "";
    const eventDeadline = Date.now() + 5_000;
    while (Date.now() < eventDeadline && !eventText.includes('"kind":"item_result"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      eventText += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    expect(eventText).toContain('"kind":"item_result"');

    const assets = await getJson("/api/v1/assets?limit=20");
    const data = assets as {
      data: {
        total: number;
        items: {
          id: string;
          mediaKind: string;
          availability: string;
          previewFileUrl: string | null;
          originalFileUrl: string | null;
        }[];
        groupCounts: { mp4: number; gif: number; image: number; missingOccurrences: number };
      };
    };
    expect(data.data.groupCounts).toMatchObject({ mp4: 1, gif: 1, image: 1, missingOccurrences: 1 });
    expect(data.data.items.every((item) => item.availability === "available")).toBe(true);
    const png = data.data.items.find((item) => item.mediaKind === "image");
    expect(png).toBeDefined();
    assetId = png?.id ?? "";
    expect(png?.previewFileUrl).not.toBeNull();

    const source = context.database.db
      .prepare("SELECT id FROM sources WHERE kind = 'local_markdown'")
      .get() as { id: string };
    const sourceContext = (await getJson(`/api/v1/sources/${source.id}`)) as {
      data: {
        occurrences: {
          locator: { kind: string; line: number };
          beforeText: string;
          afterText: string;
          mediaStatus: string;
          errorCode: string | null;
        }[];
      };
    };
    expect(sourceContext.data.occurrences).toHaveLength(3);
    expect(sourceContext.data.occurrences[0]).toMatchObject({
      locator: { kind: "markdown", line: 7 },
      mediaStatus: "missing",
      errorCode: "MISSING_DEPENDENCY",
    });
    expect(sourceContext.data.occurrences[0]?.beforeText).toContain("第二段");
    expect(sourceContext.data.occurrences[0]?.afterText).toContain("第三段");
    expect(JSON.stringify(sourceContext.data.occurrences)).not.toContain("blockId");
    expect(sourceContext.data.occurrences[1]?.mediaStatus).toBe("available");
    expect(sourceContext.data.occurrences[2]?.mediaStatus).toBe("unsupported");
  }, 90_000);

  it("streams chunked uploads, dedupes across sources and replays consumed selection", async () => {
    const first = await uploadChunk({
      relativePath: "uploads/logo.png",
      declaredBytes: originalPng.byteLength,
      chunkIndex: 0,
      chunkCount: 2,
      chunkBytes: originalPng.subarray(0, 1000),
    });
    expect(first).toMatchObject({ complete: false, nextChunk: 1 });
    const second = await uploadChunk({
      fileId: first.fileId,
      chunkIndex: 1,
      chunkCount: 2,
      chunkBytes: originalPng.subarray(1000),
    });
    expect(second).toMatchObject({
      complete: true,
      sha256: "18a0836442b0f6086edb077cdcbaa3f8917a29a400651c1e1a7bc88affbb3622",
      magicKind: "image",
    });
    const created = await writeJson("POST", "/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "upload",
      fileIds: [second.fileId],
      options: { generatePreviews: true },
    });
    const uploadScanId = (created as { data: { scanId: string } }).data.scanId;
    await waitScan(uploadScanId, (value) => value.status === "ready");
    const request = {
      schemaVersion: 1,
      scanId: uploadScanId,
      selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
    } as const;
    const imported = await writeJson("POST", "/api/v1/imports", request);
    const uploadImportId = (imported as { data: { importId: string } }).data.importId;
    await waitImport(uploadImportId, (value) => value.status === "succeeded");
    const replay = await writeJson("POST", "/api/v1/imports", request);
    expect((replay as { data: { importId: string } }).data.importId).toBe(uploadImportId);
    const sameAsset = context.database.db
      .prepare("SELECT id FROM assets WHERE blob_hash = ?")
      .get("18a0836442b0f6086edb077cdcbaa3f8917a29a400651c1e1a7bc88affbb3622");
    expect(sameAsset).toEqual({ id: assetId });
    const occurrences = context.database.db
      .prepare("SELECT COUNT(*) AS count FROM occurrences WHERE asset_id = ?")
      .get(assetId);
    expect(occurrences).toEqual({ count: 3 });
  }, 90_000);

  it("serves exact ranges, ETag and HEAD without changing bytes", async () => {
    const hash = "18a0836442b0f6086edb077cdcbaa3f8917a29a400651c1e1a7bc88affbb3622";
    const ranged = await fetch(`${base}/api/v1/files/${hash}`, {
      headers: { cookie, range: "bytes=10-41" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 10-41/${originalPng.byteLength}`,
    );
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(originalPng.subarray(10, 42));

    const suffix = await fetch(`${base}/api/v1/files/${hash}`, {
      headers: { cookie, range: "bytes=-16" },
    });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(
      originalPng.subarray(originalPng.byteLength - 16),
    );

    const ifRangeMismatch = await fetch(`${base}/api/v1/files/${hash}`, {
      headers: { cookie, range: "bytes=0-9", "if-range": '"different-etag"' },
    });
    expect(ifRangeMismatch.status).toBe(200);
    expect(Buffer.from(await ifRangeMismatch.arrayBuffer())).toEqual(originalPng);

    const head = await fetch(`${base}/api/v1/files/${hash}`, {
      method: "HEAD",
      headers: { cookie },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(`"${hash}"`);
    expect(head.headers.get("content-length")).toBe(String(originalPng.byteLength));
    expect(await head.text()).toBe("");

    const notModified = await fetch(`${base}/api/v1/files/${hash}`, {
      headers: { cookie, "if-none-match": `"${hash}"` },
    });
    expect(notModified.status).toBe(304);
    const invalid = await fetch(`${base}/api/v1/files/${hash}`, {
      headers: { cookie, range: "bytes=999999-" },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(
      `bytes */${originalPng.byteLength}`,
    );
    expect(await stat(join(context.config.dataRoot, "blobs/sha256", hash.slice(0, 2), hash))).toBeTruthy();
  });

  it("patches title and tags with immutable versions and CAS conflicts", async () => {
    const key = randomUUID();
    const body = {
      schemaVersion: 1,
      expectedVersion: 0,
      title: "人工品牌标题",
      tags: ["品牌", "Logo", "品牌"],
    };
    const first = await writeJson("PATCH", `/api/v1/assets/${assetId}`, body, key);
    expect(first).toMatchObject({
      data: {
        version: 1,
        title: "人工品牌标题",
        tags: ["品牌", "Logo"],
        origins: { title: "manual", tags: "manual" },
      },
    });
    const replay = await writeJson("PATCH", `/api/v1/assets/${assetId}`, body, key);
    expect(replay).toEqual(first);
    const conflict = await rawJson("PATCH", `/api/v1/assets/${assetId}`, {
      schemaVersion: 1,
      expectedVersion: 0,
      title: "过期标题",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: {
        code: "ASSET_VERSION_CONFLICT",
        details: { currentVersion: 1, current: { title: "人工品牌标题" } },
      },
    });
    const versions = context.database.db
      .prepare("SELECT version, title FROM asset_versions WHERE asset_id = ? ORDER BY version")
      .all(assetId);
    expect(versions).toEqual([
      { version: 0, title: "logo" },
      { version: 1, title: "人工品牌标题" },
    ]);
  });

  it("keeps manual fields when the same blob is imported from a new source", async () => {
    const uploaded = await uploadChunk({
      relativePath: "another-source/logo.png",
      declaredBytes: originalPng.byteLength,
      chunkIndex: 0,
      chunkCount: 1,
      chunkBytes: originalPng,
    });
    const created = await writeJson("POST", "/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "upload",
      fileIds: [uploaded.fileId],
      options: { generatePreviews: true },
    });
    const scanIdValue = (created as { data: { scanId: string } }).data.scanId;
    await waitScan(scanIdValue, (value) => value.status === "ready");
    const imported = await writeJson("POST", "/api/v1/imports", {
      schemaVersion: 1,
      scanId: scanIdValue,
      selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
    });
    await waitImport(
      (imported as { data: { importId: string } }).data.importId,
      (value) => value.status === "succeeded",
    );
    const detail = (await getJson(`/api/v1/assets/${assetId}`)) as {
      data: {
        summary: { version: number; title: string; tags: string[] };
        humanFields: { origins: { title: string; tags: string } };
      };
    };
    expect(detail.data.summary).toMatchObject({
      version: 1,
      title: "人工品牌标题",
      tags: ["品牌", "Logo"],
    });
    expect(detail.data.humanFields.origins).toEqual({ title: "manual", tags: "manual" });
  }, 60_000);

  it("rejects stale fences before writing another occurrence", async () => {
    const before = context.database.db
      .prepare("SELECT COUNT(*) AS count FROM occurrences")
      .get();
    const item = context.database.db
      .prepare("SELECT id, relative_path FROM scan_items WHERE media_kind_guess = 'image' LIMIT 1")
      .get() as { id: string; relative_path: string };
    await expect(
      context.imports.acceptItemResult({
        schemaVersion: 1,
        type: "item_result",
        messageId: randomUUID(),
        fence: {
          jobId: importId,
          attempt: 99,
          leaseOwner: "stale",
          leaseGeneration: 99,
        },
        kind: "scan_item",
        item: {
          scanItemId: randomUUID(),
          relativePath: item.relative_path,
          basename: "logo.png",
          kind: "image",
          mime: "image/png",
          bytes: originalPng.byteLength,
          mtimeMs: 1,
          deviceId: "1",
          inode: "1",
          magicPrefixHex: "89504e470d0a1a0a",
          status: "candidate",
          exclusionCode: null,
          metadata: { extensionMismatch: false, extension: ".png" },
        },
        stagedFiles: [],
      }),
    ).rejects.toMatchObject({ code: "JOB_STALE_LEASE" });
    expect(
      context.database.db.prepare("SELECT COUNT(*) AS count FROM occurrences").get(),
    ).toEqual(before);
  });

  async function uploadChunk(input: {
    fileId?: string;
    relativePath?: string;
    declaredBytes?: number;
    chunkIndex: number;
    chunkCount: number;
    chunkBytes: Buffer;
  }): Promise<{ fileId: string; complete: boolean; nextChunk: number; sha256: string | null; magicKind: string | null }> {
    const form = new FormData();
    if (input.fileId !== undefined) form.set("fileId", input.fileId);
    if (input.relativePath !== undefined) form.set("relativePath", input.relativePath);
    if (input.declaredBytes !== undefined) form.set("declaredBytes", String(input.declaredBytes));
    form.set("chunkIndex", String(input.chunkIndex));
    form.set("chunkCount", String(input.chunkCount));
    const chunkHash = await sha256(input.chunkBytes);
    form.set("chunkSha256", chunkHash);
    form.set("file", new Blob([input.chunkBytes]), "chunk.bin");
    const response = await fetch(`${base}/api/v1/uploads`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "Idempotency-Key": randomUUID(),
        origin: base,
      },
      body: form,
    });
    if (response.status !== 201) {
      throw new Error(`upload failed ${response.status}: ${await response.text()}`);
    }
    return ((await response.json()) as { data: never }).data;
  }

  async function waitScan(scanIdValue: string, predicate: (value: { status: string; counts: Record<string, number> }) => boolean) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const body = await getJson(`/api/v1/imports/scans/${scanIdValue}`);
      const data = (body as { data: { status: string; counts: Record<string, number> } }).data;
      if (predicate(data)) return data;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("scan timeout");
  }

  async function waitImport(importIdValue: string, predicate: (value: { status: string }) => boolean) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const body = await getJson(`/api/v1/imports/${importIdValue}`);
      const data = (body as { data: { status: string; counts: Record<string, number> } }).data;
      if (predicate(data)) return data;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("import timeout");
  }

  async function getJson(path: string): Promise<unknown> {
    const response = await fetch(`${base}${path}`, { headers: { cookie } });
    return await response.json();
  }

  async function writeJson(method: string, path: string, body: unknown, key = randomUUID()): Promise<unknown> {
    const response = await rawJson(method, path, body, key);
    if (response.status >= 400) {
      throw new Error(`${method} ${path} failed ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return response.body;
  }

  async function rawJson(method: string, path: string, body: unknown, key = randomUUID()) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "Idempotency-Key": key,
        "content-type": "application/json",
        origin: base,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function sha256(value: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
