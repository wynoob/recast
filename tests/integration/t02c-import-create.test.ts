import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ScanItemResult } from "@dmall/contracts";
import {
  startT02cApp,
  type T02cTestApp,
} from "./t02c-test-helpers.js";

describe("T02c same-batch import creation", () => {
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

  it("accepts a mapping and media together with no pre-imported sourceVersion", async () => {
    const fixture = await scanFixture("docs/notes.md", "docs/asset-map.md", "media/a.png");
    const scan = fixture;
    expect(
      app.context.database.db.prepare("SELECT COUNT(*) AS count FROM source_versions").get(),
    ).toEqual({ count: 0 });
    const mappingId = fixture.itemId("docs/asset-map.md");
    const body = importBody(scan.scanId, [mappingId]);
    const response = await app.writeJson("POST", "/api/v1/imports", body);
    const data = (response as { data: { importId: string; status: string } }).data;
    expect(data.status).toBe("queued");
    const job = app.context.database.db
      .prepare("SELECT input_json, state FROM jobs WHERE id = ?")
      .get(data.importId) as { input_json: string; state: string };
    expect(JSON.parse(job.input_json)).toMatchObject({
      jobType: "local_import",
      scanId: scan.scanId,
      assetMap: {
        format: "markdown-asset-table/v1",
        sourceScanItemIds: [mappingId],
      },
    });
    expect(
      app.context.database.db
        .prepare("SELECT COUNT(*) AS count FROM import_items WHERE import_job_id = ?")
        .get(data.importId),
    ).toEqual({ count: 3 });
    expect(
      app.context.database.db
        .prepare("SELECT status, selection_hash FROM import_scans WHERE id = ?")
        .get(scan.scanId),
    ).toMatchObject({ status: "consumed" });
  });

  it("rejects mapping ids outside the scan or final selection and non-Markdown items", async () => {
    const fixture = await scanFixture("docs/notes.md", "docs/asset-map.md", "media/a.png");
    const scan = fixture;
    const mappingId = fixture.itemId("docs/asset-map.md");
    const imageId = fixture.itemId("media/a.png");
    const outside = await app.rawJson("POST", "/api/v1/imports", {
      ...importBody(scan.scanId, [randomUUID()]),
    });
    expect(outside.status).toBe(422);
    const notSelected = await app.rawJson("POST", "/api/v1/imports", {
      ...importBody(scan.scanId, [mappingId]),
      selection: {
        mode: "explicit",
        includeItemIds: [imageId],
        excludeItemIds: [],
      },
    });
    expect(notSelected.status).toBe(422);
    const nonMarkdown = await app.rawJson("POST", "/api/v1/imports", {
      ...importBody(scan.scanId, [imageId]),
    });
    expect(nonMarkdown.status).toBe(422);
    expect(
      app.context.database.db
        .prepare("SELECT status FROM import_scans WHERE id = ?")
        .get(scan.scanId),
    ).toEqual({ status: "ready" });
  });

  it("rejects duplicate and four-item arrays and enforces the 1MiB boundary", async () => {
    const fixture = await scanFixture(
      "docs/a.md",
      "large.md",
      "media/a.png",
      "media/b.png",
    );
    const scan = fixture;
    const a = fixture.itemId("docs/a.md");
    const duplicate = await app.rawJson("POST", "/api/v1/imports", {
      ...importBody(scan.scanId, [a, a]),
    });
    expect(duplicate.status).toBe(422);
    const four = await app.rawJson("POST", "/api/v1/imports", {
      ...importBody(scan.scanId, [a, a, a, a]),
    });
    expect(four.status).toBe(422);
    await fixture.setBytes("large.md", 1_048_576);
    const exact = await app.rawJson("POST", "/api/v1/imports", {
      ...importBody(scan.scanId, [fixture.itemId("large.md")]),
    });
    expect(exact.status).toBe(202);
  });

  it("rejects a mapping over 1MiB with MAPPING_TOO_LARGE and leaves the scan ready", async () => {
    const fixture = await scanFixture("large.md", "media/a.png");
    const scan = fixture;
    await fixture.setBytes("large.md", 1_048_577);
    const response = await app.rawJson("POST", "/api/v1/imports", {
      ...importBody(scan.scanId, [fixture.itemId("large.md")]),
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: "MAPPING_TOO_LARGE" } });
    expect(
      app.context.database.db
        .prepare("SELECT status FROM import_scans WHERE id = ?")
        .get(scan.scanId),
    ).toEqual({ status: "ready" });
  });

  it("replays consumed identity and rejects a different assetMap", async () => {
    const fixture = await scanFixture("docs/a.md", "docs/b.md", "media/a.png");
    const scan = fixture;
    const a = fixture.itemId("docs/a.md");
    const b = fixture.itemId("docs/b.md");
    const body = importBody(scan.scanId, [a]);
    const key = randomUUID();
    const first = await app.rawJson("POST", "/api/v1/imports", body, key);
    expect(first.status).toBe(202);
    const sameKey = await app.rawJson("POST", "/api/v1/imports", body, key);
    expect((sameKey.body as { data: unknown }).data).toEqual(
      (first.body as { data: unknown }).data,
    );
    const sameSelectionNewKey = await app.rawJson("POST", "/api/v1/imports", body);
    expect(sameSelectionNewKey.status).toBe(202);
    expect((sameSelectionNewKey.body as { data: { importId: string } }).data.importId).toBe(
      (first.body as { data: { importId: string } }).data.importId,
    );
    const different = await app.rawJson(
      "POST",
      "/api/v1/imports",
      importBody(scan.scanId, [b]),
    );
    expect(different.status).toBe(409);
    expect(different.body).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("filters scan items by kind without selecting a filename automatically", async () => {
    const fixture = await scanFixture("docs/notes.md", "docs/asset-map.md", "media/a.png");
    const scan = fixture;
    const items = (await app.getJson(
      `/api/v1/imports/scans/${scan.scanId}/items?kind=markdown&limit=1`,
    )) as {
      data: {
        items: { id: string; relativePath: string; kind: string }[];
        nextCursor: string | null;
        total: number;
      };
    };
    expect(items.data.total).toBe(2);
    expect(items.data.items).toHaveLength(1);
    expect(items.data.items[0]?.kind).toBe("markdown");
    expect(items.data.nextCursor).toBe("1");
    const second = (await app.getJson(
      `/api/v1/imports/scans/${scan.scanId}/items?kind=markdown&limit=1&cursor=1`,
    )) as { data: { items: { relativePath: string }[] } };
    expect(second.data.items[0]?.relativePath).toMatch(/asset-map\.md|notes\.md/u);

    const body = importBody(scan.scanId, undefined);
    const response = await app.writeJson("POST", "/api/v1/imports", body);
    const input = app.context.database.db
      .prepare("SELECT input_json FROM jobs WHERE id = ?")
      .get((response as { data: { importId: string } }).data.importId) as { input_json: string };
    expect(JSON.parse(input.input_json)).not.toHaveProperty("assetMap");
  });

  async function scanFixture(...relativePaths: string[]) {
    const root = await mkdtemp(join(tmpdir(), "dcw-t02c-create-"));
    roots.push(root);
    for (const relativePath of relativePaths) {
      const absolute = join(root, ...relativePath.split("/"));
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, relativePath.endsWith(".md") ? "# 文档\n" : "media");
    }
    const created = (await app.writeJson("POST", "/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: root,
      options: { generatePreviews: true },
    })) as { data: { scanId: string } };
    const scanId = created.data.scanId;
    const items = new Map<string, string>();
    for (const [ordinal, relativePath] of relativePaths.entries()) {
      const absolute = join(root, ...relativePath.split("/"));
      const file = await stat(absolute);
      const kind = relativePath.endsWith(".md") ? "markdown" : "image";
      const item: ScanItemResult = {
        scanItemId: randomUUID(),
        relativePath,
        basename: relativePath.split("/").at(-1) ?? relativePath,
        kind,
        mime: kind === "markdown" ? "text/markdown" : "image/png",
        bytes: relativePath.endsWith(".md") ? (await readFile(absolute)).byteLength : file.size,
        mtimeMs: file.mtimeMs,
        deviceId: String(file.dev),
        inode: String(file.ino),
        magicPrefixHex: kind === "markdown" ? "" : "89504e47",
        status: "candidate",
        exclusionCode: null,
        metadata: { extensionMismatch: false, extension: relativePath.split(".").at(-1) ?? "" },
      };
      const stored = app.context.imports.repository.upsertScanItem(scanId, item);
      items.set(relativePath, stored.id);
    }
    app.context.imports.repository.finalizeScan(scanId, {
      status: "ready",
      manifestHash: createHash("sha256").update(relativePaths.join("\n")).digest("hex"),
    });
    return {
      scanId,
      itemId(relativePath: string) {
        const id = items.get(relativePath);
        if (id === undefined) throw new Error(`missing scan item ${relativePath}`);
        return id;
      },
      async setBytes(relativePath: string, bytes: number) {
        const id = items.get(relativePath);
        if (id === undefined) throw new Error(`missing scan item ${relativePath}`);
        app.context.database.db
          .prepare("UPDATE scan_items SET bytes = ? WHERE id = ?")
          .run(bytes, id);
        app.context.imports.repository.finalizeScan(scanId, {
          status: "ready",
          manifestHash: createHash("sha256").update(`${relativePath}:${bytes}`).digest("hex"),
        });
      },
    };
  }
});

function importBody(scanId: string, mappingIds: string[] | undefined): Record<string, unknown> {
  return {
    schemaVersion: 1,
    scanId,
    selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
    options: {
      generatePreviews: true,
      ocr: "blocked",
      allowExternalModel: false,
      allowFeishu: false,
    },
    ...(mappingIds === undefined
      ? {}
      : {
          assetMap: {
            format: "markdown-asset-table/v1",
            sourceScanItemIds: mappingIds,
          },
        }),
  };
}
