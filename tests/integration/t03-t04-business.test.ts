import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedEvidenceSchema } from "@dmall/contracts";
import { createApp, type AppContext } from "../../apps/server/src/app.js";
import type { RuntimeConfig } from "../../apps/server/src/config.js";
import {
  makePdf,
  S08_PATH,
} from "../../packages/local-adapters/tests/fixtures.js";
import {
  createInternalContent,
  selectInternalEvidence,
} from "./internal-authoring-helpers.js";

interface TestClient {
  context: AppContext;
  base: string;
  cookie: string;
  csrf: string;
  get(path: string): Promise<{ status: number; body: unknown }>;
  write(path: string, body: unknown, key?: string): Promise<{ status: number; body: unknown }>;
}

describe("T03/T04 local document business chain", () => {
  let client: TestClient;
  let fixtureRoot: string;
  let dataRoot: string;
  let importIdForFence: string;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "dcw-t0304-fixture-"));
    dataRoot = await mkdtemp(join(tmpdir(), "dcw-t0304-data-"));
    await mkdir(join(fixtureRoot, "assets"), { recursive: true });
    const logo = await readFile(
      join(
        process.cwd(),
        "input/Dmall内容工作台-完整交接包-v1.0/materials/local/public/assets/brand/dmall-logo.png",
      ),
    );
    await writeFile(join(fixtureRoot, "assets/logo.png"), logo);
    await writeFile(
      join(fixtureRoot, "guide.md"),
      [
        "# 经营结论",
        "",
        "手机端查询销量演示，用于核对章节正文。",
        "",
        "第二条正文保留为同一 chunk 的第二个块。",
        "",
        "![本地图](assets/logo.png)",
        "",
        "## 只有标题",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(fixtureRoot, "static.html"),
      [
        "<!doctype html><html><head><title>静态经营报告</title><script>BAD_SCRIPT()</script></head>",
        "<body><h1>经营结论</h1><p>静态 HTML 正文</p><img src=\"assets/logo.png\"><img src=\"assets/missing.png\"></body></html>",
      ].join(""),
    );
    const archiveHtml = "<!doctype html><html><body><h1>离线报告</h1><p>HTML ZIP 正文</p><img src=\"assets/logo.png\"></body></html>";
    const bundleRoot = await mkdtemp(join(tmpdir(), "dcw-t0304-bundle-"));
    await mkdir(join(bundleRoot, "assets"), { recursive: true });
    await writeFile(join(bundleRoot, "index.html"), archiveHtml);
    await copyFile(join(fixtureRoot, "assets/logo.png"), join(bundleRoot, "assets/logo.png"));
    const zipped = spawnSync("zip", ["-q", "-r", join(fixtureRoot, "bundle.zip"), "."], {
      cwd: bundleRoot,
    });
    if (zipped.status !== 0) throw new Error("zip fixture failed");
    await writeFile(join(fixtureRoot, "report.pdf"), await makePdf(["PDF 第一页", "PDF 第二页"]));
    await copyFile(S08_PATH, join(fixtureRoot, "S08.pptx"));

    const port = await freePort();
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
    const context = await createApp({ config });
    await context.app.listen({ host: "127.0.0.1", port });
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/api/v1/health`);
    const setCookie = health.headers.get("set-cookie");
    if (setCookie === null) throw new Error("missing session cookie");
    const cookie = setCookie.split(";")[0] ?? "";
    const healthBody = zHealth(await health.json());
    client = {
      context,
      base,
      cookie,
      csrf: healthBody.data.csrfToken,
      async get(path) {
        const response = await fetch(`${base}${path}`, { headers: { cookie } });
        return { status: response.status, body: await response.json() };
      },
      async write(path, body, key = randomUUID()) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            cookie,
            origin: base,
            "content-type": "application/json",
            "x-csrf-token": healthBody.data.csrfToken,
            "idempotency-key": key,
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
    };
  }, 30_000);

  afterAll(async () => {
    await client.context.app.close();
  });

  it("imports local documents, indexes text, preserves locators and exposes stale handles", async () => {
    const created = await client.write("/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: fixtureRoot,
      options: { generatePreviews: true },
    });
    expect(created.status).toBe(202);
    const scanId = dataOf<{ scanId: string }>(created.body).scanId;
    const scan = await waitFor(async () => {
      const result = await client.get(`/api/v1/imports/scans/${scanId}`);
      return statusData(result.body).status === "ready" ? statusData(result.body) : null;
    });
    expect(scan.counts).toMatchObject({
      markdown: 1,
      html: 1,
      htmlZip: 1,
      pdf: 1,
      pptx: 1,
      image: 1,
    });

    const imported = await client.write("/api/v1/imports", {
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
    expect(imported.status).toBe(202);
    const importId = dataOf<{ importId: string }>(imported.body).importId;
    importIdForFence = importId;
    const detail = await waitFor(async () => {
      const result = await client.get(`/api/v1/imports/${importId}`);
      const value = statusData(result.body);
      return ["succeeded", "partial", "failed"].includes(value.status) ? value : null;
    }, 120_000);
    expect(detail.status).toBe("partial");
    expect(detail.counts).toMatchObject({ committed: 6, failed: 0 });

    const sources = dataOf<{ items: Array<{ id: string; kind: string; currentVersionId: string }> }>(
      (await client.get("/api/v1/sources?limit=100")).body,
    ).items;
    const markdown = sources.find((source) => source.kind === "local_markdown");
    const html = sources.find((source) => source.kind === "local_html");
    const pdf = sources.find((source) => source.kind === "local_pdf");
    const pptx = sources.find((source) => source.kind === "local_pptx");
    expect(markdown).toBeDefined();
    expect(html).toBeDefined();
    expect(pdf).toBeDefined();
    expect(pptx).toBeDefined();

    const markdownContext = dataOf<{
      document: {
        sections: Array<{ title: string; text: string; blocks: Array<{ text: string }> }>;
      } | null;
    }>(
      (await client.get(`/api/v1/sources/${markdown?.id}?versionId=${markdown?.currentVersionId}`)).body,
    );
    expect(markdownContext.document?.sections.map((section) => section.title)).toEqual([
      "经营结论",
      "只有标题",
    ]);
    expect(markdownContext.document?.sections[0]?.text).toContain("手机端查询销量演示");
    expect(markdownContext.document?.sections[1]?.blocks).toEqual([]);

    const htmlContext = dataOf<{
      document: { snapshot: { status: string; warnings: Array<{ code: string }> }; sections: Array<{ text: string }> } | null;
    }>(
      (await client.get(`/api/v1/sources/${html?.id}?versionId=${html?.currentVersionId}`)).body,
    );
    expect(htmlContext.document?.snapshot.status).toBe("partial");
    expect(htmlContext.document?.snapshot.warnings.map((warning) => warning.code)).toContain(
      "DYNAMIC_HTML_NEEDS_ADAPTER",
    );
    expect(JSON.stringify(htmlContext.document)).not.toContain("BAD_SCRIPT()");

    const pdfContext = dataOf<{
      document: { snapshot: { pageCount: number } } | null;
      occurrences: Array<{ locator: { kind: string; page?: number } }>;
    }>(
      (await client.get(`/api/v1/sources/${pdf?.id}?versionId=${pdf?.currentVersionId}`)).body,
    );
    expect(pdfContext.document?.snapshot.pageCount).toBe(2);
    expect(pdfContext.occurrences.map((occurrence) => occurrence.locator.page)).toEqual([1, 2]);
    const pptxContext = dataOf<{
      document: {
        snapshot: { pageCount: number; status: string; capabilities: { pageImages: string } };
        sections: unknown[];
      } | null;
      occurrences: Array<{ locator: { kind: string; page?: number } }>;
    }>(
      (await client.get(`/api/v1/sources/${pptx?.id}?versionId=${pptx?.currentVersionId}`)).body,
    );
    expect(pptxContext.document?.snapshot.pageCount).toBe(12);
    expect(pptxContext.document?.snapshot.status).toBe("partial");
    expect(pptxContext.document?.snapshot.capabilities.pageImages).toBe("unavailable");
    expect(pptxContext.document?.sections).toHaveLength(12);
    expect(pptxContext.occurrences).toHaveLength(16);
    expect(
      pptxContext.occurrences.every(
        (occurrence) =>
          occurrence.locator.kind === "page" &&
          occurrence.locator.page !== undefined &&
          occurrence.locator.page >= 1 &&
          occurrence.locator.page <= 12,
      ),
    ).toBe(true);

    const search = await searchQuery("手机端查询销量");
    expect(search.indexGenerationId).toMatch(uuidPattern);
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]).toMatchObject({
      refType: "source_version",
      sourceId: markdown?.id,
      sourceVersionId: markdown?.currentVersionId,
    });
    const multiBlock = search.hits.find((hit) => hit.blockIds.length >= 2);
    expect(multiBlock).toBeDefined();
    const selection = dataOf<{
      blocks: Array<{ id: string; text: string }>;
      sourceDocumentUrl: string | null;
      sourceVersionId: string | null;
    }>(
      (await client.get(`/api/v1/selections/${multiBlock?.selectionHandle}`)).body,
    );
    expect(selection.blocks.map((block) => block.text).join(" ")).toContain("手机端查询销量");
    expect(selection.sourceDocumentUrl).toContain("/api/v1/sources/");

    const headingOnly = await searchQuery("只有标题");
    expect(headingOnly.hits[0]?.blockIds).toEqual([]);
    const content = createInternalContent(client, {
      schemaVersion: 1,
      title: "检索固定素材",
      kind: "feishu_doc",
    });
    expect(content.status).toBe(201);
    const contentId = dataOf<{ id: string }>(content.body).id;
    const headingPinned = selectInternalEvidence(client, contentId, {
      schemaVersion: 1,
      selectionHandles: [headingOnly.hits[0]?.selectionHandle],
    });
    expect(headingPinned.status).toBe(201);
    const headingEvidence = FixedEvidenceSchema.parse(
      dataOf<{ items: unknown[] }>(headingPinned.body).items[0],
    );
    expect(headingEvidence.kind).toBe("source");
    if (headingEvidence.kind !== "source") throw new Error("source evidence expected");
    expect(headingEvidence.exactText).toContain("只有标题");
    expect(headingEvidence.chunks[0]?.blockIds).toEqual([]);
    expect(headingEvidence.chunks[0]?.locators.length).toBeGreaterThan(0);

    const assets = dataOf<{
      items: Array<{ id: string; version: number; title: string; occurrenceCount: number }>;
    }>(
      (await client.get("/api/v1/assets?limit=100")).body,
    ).items;
    const logo = assets.find((asset) => asset.title === "logo.png");
    expect(logo).toBeDefined();
    expect(logo?.occurrenceCount).toBe(4);
    const patched = await fetch(`${client.base}/api/v1/assets/${logo?.id}`, {
      method: "PATCH",
      headers: {
        cookie: client.cookie,
        origin: client.base,
        "content-type": "application/json",
        "x-csrf-token": client.csrf,
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        schemaVersion: 1,
        expectedVersion: logo?.version,
        title: "人工标题即时检索",
        tags: ["品牌"],
      }),
    });
    expect(patched.status).toBe(200);
    const refreshed = await searchQuery("人工标题即时检索");
    expect(refreshed.hits.some((hit) => hit.refType === "source_version")).toBe(true);
    const mediaPinned = selectInternalEvidence(client, contentId, {
      schemaVersion: 1,
      selectionHandles: [refreshed.hits[0]?.selectionHandle],
    });
    expect(mediaPinned.status).toBe(201);
    const mediaEvidence = FixedEvidenceSchema.parse(
      dataOf<{ items: unknown[] }>(mediaPinned.body).items[0],
    );
    expect(mediaEvidence.kind).toBe("media");
    if (mediaEvidence.kind !== "media") throw new Error("media evidence expected");
    expect(mediaEvidence.assetId).toBe(logo?.id);
    expect(mediaEvidence.occurrence?.sourceVersionId).toBe(refreshed.hits[0]?.sourceVersionId);
    expect(mediaEvidence.blobHash).toMatch(/^[a-f0-9]{64}$/);
    const stale = await client.get(`/api/v1/selections/${multiBlock?.selectionHandle}`);
    expect(stale.status).toBe(409);
    expect(errorCode(stale.body)).toBe("SEARCH_SELECTION_STALE");

    const pdfSection = dataOf<{
      document: { sections: Array<{ locator: unknown }> } | null;
    }>(
      (await client.get(`/api/v1/sources/${pdf?.id}?versionId=${pdf?.currentVersionId}`)).body,
    ).document?.sections[0];
    expect(pdfSection).toBeDefined();
    const merchantA = randomUUID();
    const factText = "事实" + "值".repeat(1_198);
    const fact = await client.write("/api/v1/facts", {
      schemaVersion: 1,
      canonicalKey: "merchant-a:demo:demo",
      version: {
        value: 1200,
        unit: "次",
        merchantId: merchantA,
        period: { start: "2026-01-01", end: "2026-01-31" },
        kind: "user_assertion",
        sourceVersionId: pdf?.currentVersionId,
        sourceLocator: pdfSection?.locator,
        status: "unverified",
        indexText: factText,
      },
    });
    expect(fact.status).toBe(201);
    const factEntity = dataOf<{ id: string; currentVersion: { indexText: string; status: string } }>(fact.body);
    expect(factEntity.currentVersion.indexText).toHaveLength(1_200);
    expect(factEntity.currentVersion.status).toBe("unverified");
    const factSearch = await searchQuery("事实值值值", merchantA);
    expect(factSearch.hits[0]?.refType).toBe("fact");
    const factSelection = dataOf<{ fact: { id: string; currentVersion: { indexText: string } } | null }>(
      (await client.get(`/api/v1/selections/${factSearch.hits[0]?.selectionHandle}`)).body,
    );
    expect(factSelection.fact).toMatchObject({ id: factEntity.id });
    expect(factSelection.fact?.currentVersion.indexText).toHaveLength(1_200);

    const wrongMerchant = await searchQuery("事实值值值", randomUUID());
    expect(wrongMerchant.hits).toEqual([]);

    const tooLong = await client.write("/api/v1/facts", {
      schemaVersion: 1,
      canonicalKey: "too-long",
      version: {
        value: "x",
        unit: "个",
        merchantId: null,
        period: null,
        kind: "measured",
        sourceVersionId: pdf?.currentVersionId,
        sourceLocator: pdfSection?.locator,
        indexText: "长".repeat(1_201),
      },
    });
    expect(tooLong.status).toBe(422);
    expect(dataRoot).not.toContain("Application Support");
  }, 180_000);

  it("reuses the complete document identity when the same snapshot is imported again", async () => {
    const before = client.context.database.db
      .prepare(
        `SELECT sv.id AS version_id,
                (SELECT COUNT(*) FROM document_sections ds WHERE ds.source_version_id = sv.id) AS section_count,
                (SELECT COUNT(*) FROM document_blocks db WHERE db.source_version_id = sv.id) AS block_count
         FROM source_versions sv JOIN sources s ON s.id = sv.source_id
         WHERE s.kind = 'local_markdown'
         ORDER BY sv.created_at ASC LIMIT 1`,
      )
      .get();
    expect(typeof before).toBe("object");

    const scanResult = await client.write("/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: fixtureRoot,
      options: { generatePreviews: true },
    });
    const scanId = dataOf<{ scanId: string }>(scanResult.body).scanId;
    await waitFor(async () => {
      const result = await client.get(`/api/v1/imports/scans/${scanId}`);
      return statusData(result.body).status === "ready" ? true : null;
    });
    const items = dataOf<{ items: Array<{ id: string; relativePath: string }> }>(
      (await client.get(`/api/v1/imports/scans/${scanId}/items?limit=100`)).body,
    ).items;
    const guide = items.find((item) => item.relativePath === "guide.md");
    expect(guide).toBeDefined();
    const imported = await client.write("/api/v1/imports", {
      schemaVersion: 1,
      scanId,
      selection: {
        mode: "explicit",
        includeItemIds: [guide?.id],
        excludeItemIds: [],
      },
      options: {
        generatePreviews: true,
        ocr: "blocked",
        allowExternalModel: false,
        allowFeishu: false,
      },
    });
    const importId = dataOf<{ importId: string }>(imported.body).importId;
    const detail = await waitFor(async () => {
      const result = await client.get(`/api/v1/imports/${importId}`);
      const value = statusData(result.body);
      return ["succeeded", "partial", "failed"].includes(value.status) ? value : null;
    });
    expect(detail.counts.committed).toBe(1);
    const after = client.context.database.db
      .prepare(
        `SELECT sv.id AS version_id,
                (SELECT COUNT(*) FROM document_sections ds WHERE ds.source_version_id = sv.id) AS section_count,
                (SELECT COUNT(*) FROM document_blocks db WHERE db.source_version_id = sv.id) AS block_count
         FROM source_versions sv JOIN sources s ON s.id = sv.source_id
         WHERE s.kind = 'local_markdown'
         ORDER BY sv.created_at ASC LIMIT 1`,
      )
      .get();
    expect(after).toEqual(before);
  });

  it("rejects a late document media batch from an old job fence", async () => {
    const snapshot = client.context.jobs.snapshotById(importIdForFence);
    const rejected = await client.context.imports.acceptItemResult({
      schemaVersion: 1,
      type: "item_result",
      messageId: randomUUID(),
      fence: {
        jobId: importIdForFence,
        attempt: snapshot.attempt,
        leaseOwner: "stale-worker",
        leaseGeneration: snapshot.leaseGeneration,
      },
      kind: "document_media_batch",
      batch: {
        scanItemId: randomUUID(),
        batchIndex: 0,
        batchCount: 1,
        media: [
          {
            adapterId: "late-media",
            mediaKind: "image",
            mediaStatus: "extracted",
            sourceInternalPath: "late.png",
            relativePath: "items/late/late.png",
            sha256: "a".repeat(64),
            bytes: 1,
            mime: "image/png",
            role: "document_media",
          },
        ],
      },
      stagedFiles: [],
    }).then(
      () => null,
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null,
    );
    expect(rejected).toBe("JOB_STALE_LEASE");
  });

  it("rejects a project package with the .dcp.zip suffix as HTML", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcw-t0304-project-package-"));
    await copyFile(join(fixtureRoot, "bundle.zip"), join(root, "project.dcp.zip"));
    const scanResult = await client.write("/api/v1/imports/scan", {
      schemaVersion: 1,
      sourceKind: "local_directory",
      rootPath: root,
      options: { generatePreviews: true },
    });
    const scanId = dataOf<{ scanId: string }>(scanResult.body).scanId;
    await waitFor(async () => {
      const result = await client.get(`/api/v1/imports/scans/${scanId}`);
      return statusData(result.body).status === "ready" ? true : null;
    });
    const imported = await client.write("/api/v1/imports", {
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
    const importId = dataOf<{ importId: string }>(imported.body).importId;
    const detail = await waitFor(async () => {
      const result = await client.get(`/api/v1/imports/${importId}`);
      const value = statusData(result.body);
      return ["succeeded", "partial", "failed"].includes(value.status) ? value : null;
    });
    expect(detail.status).toBe("failed");
    expect(detail.items).toEqual([
      expect.objectContaining({
        relativePath: "project.dcp.zip",
        state: "failed",
        errorCode: "UNSUPPORTED_FORMAT",
      }),
    ]);
  });

  async function searchQuery(query: string, merchantId?: string) {
    const result = await client.write("/api/v1/search", {
      schemaVersion: 1,
      query,
      mode: "keyword",
      limit: 20,
      filters: {
        schemaVersion: 1,
        merchantId: merchantId ?? null,
        dateFrom: null,
        dateTo: null,
        mediaKinds: [],
        audience: [],
        functions: [],
        obsolete: "exclude",
        availability: [],
      },
    });
    expect(result.status).toBe(200);
    return dataOf<{
      indexGenerationId: string;
      hits: Array<{
        refType: "source_version" | "fact";
        sourceId: string | null;
        sourceVersionId: string | null;
        blockIds: string[];
        selectionHandle: string;
      }>;
    }>(result.body);
  }
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

async function waitFor<T>(
  check: () => Promise<T | null>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("timed out waiting for result");
}

function zHealth(value: unknown): { data: { csrfToken: string } } {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null &&
    "csrfToken" in value.data &&
    typeof value.data.csrfToken === "string"
  ) {
    return { data: { csrfToken: value.data.csrfToken } };
  }
  throw new Error("health response invalid");
}

function dataOf<T>(value: unknown): T {
  if (typeof value === "object" && value !== null && "data" in value) {
    return value.data as T;
  }
  throw new Error("response data missing");
}

function statusData(value: unknown): {
  status: string;
  counts: Record<string, number>;
  items: unknown;
} {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null &&
    "status" in value.data &&
    typeof value.data.status === "string" &&
    "counts" in value.data &&
    typeof value.data.counts === "object" &&
    value.data.counts !== null
  ) {
    return {
      status: value.data.status,
      counts: Object.fromEntries(
        Object.entries(value.data.counts).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      ),
      items: "items" in value.data ? value.data.items : [],
    };
  }
  throw new Error("status response invalid");
}

function errorCode(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error &&
    typeof value.error.code === "string"
  ) {
    return value.error.code;
  }
  return null;
}
