import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { chromium } from "@playwright/test";

const ROOT = process.cwd();
const EVIDENCE = join(
  ROOT,
  "..",
  "verification-runs",
  new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
);
const DATA_ROOT = join(EVIDENCE, "data");
const FIXTURE_ROOT = join(EVIDENCE, "fixtures");
const LOG_ROOT = join(EVIDENCE, "logs");
const ARTIFACT_ROOT = join(EVIDENCE, "artifacts");
const INPUT_ROOT = join(ROOT, "input/Dmall内容工作台-完整交接包-v1.0/materials/feishu");
const PLAYWRIGHT_ROOT =
  process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(ROOT, ".tools/ms-playwright");
const QUERY_FILE = join(ROOT, "tests/fixtures/t03-t04-search-queries.json");

const state = {
  startedAt: new Date().toISOString(),
  test: "not_run",
  check: "not_run",
  build: "not_run",
  e2e: "not_run",
  externalBlocked: [
    "Feishu remote network read",
    "OCR provider",
    "embedding provider",
    "LibreOffice full-page PPTX rendering",
  ],
};

let server = null;
let browser = null;
let base = "";
let cookie = "";
let csrf = "";
let logHandle = null;

try {
  await mkdir(DATA_ROOT, { recursive: true });
  await mkdir(FIXTURE_ROOT, { recursive: true });
  await mkdir(LOG_ROOT, { recursive: true });
  await mkdir(ARTIFACT_ROOT, { recursive: true });

  const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...isolatedEnv() },
  });
  await writeFile(join(LOG_ROOT, "build.log"), `${build.stdout}${build.stderr}`);
  state.build = build.status === 0 ? "passed" : "failed";
  if (build.status !== 0) throw new Error("build failed");

  const fixtureInputs = await prepareFixtures();
  const beforeHashes = await hashFiles(fixtureInputs.map((item) => item.source));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  logHandle = await openLog(join(LOG_ROOT, "server.log"));
  server = spawn(process.execPath, ["dist/apps/server/main.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...isolatedEnv(),
      DCW_DATA_ROOT: DATA_ROOT,
      DCW_PORT: String(port),
      DCW_WEB_ROOT: join(ROOT, "dist/web"),
      DCW_WORKER_POOL_SIZE: "2",
      DCW_LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(logHandle.stream);
  server.stderr.pipe(logHandle.stream);
  await waitForServer(base);
  const health = await session();
  csrf = health.csrf;
  cookie = health.cookie;

  const scan = await api("POST", "/api/v1/imports/scan", {
    schemaVersion: 1,
    sourceKind: "local_directory",
    rootPath: FIXTURE_ROOT,
    options: { generatePreviews: true },
  }, 202);
  const scanId = scan.data.scanId;
  await waitFor(async () => {
    const detail = await api("GET", `/api/v1/imports/scans/${scanId}`);
    return detail.data.status === "ready" ? detail.data : null;
  }, 60_000);
  const imported = await api("POST", "/api/v1/imports", {
    schemaVersion: 1,
    scanId,
    selection: { mode: "all", includeItemIds: [], excludeItemIds: [] },
    options: {
      generatePreviews: true,
      ocr: "blocked",
      allowExternalModel: false,
      allowFeishu: false,
    },
  }, 202);
  const importId = imported.data.importId;
  const importDetail = await waitFor(async () => {
    const detail = await api("GET", `/api/v1/imports/${importId}`);
    return ["succeeded", "partial", "failed"].includes(detail.data.status)
      ? detail.data
      : null;
  }, 240_000);
  await writeFile(
    join(EVIDENCE, "import.json"),
    `${JSON.stringify(importDetail, null, 2)}\n`,
  );
  if (importDetail.status !== "partial" || importDetail.counts.failed !== 0) {
    throw new Error(`unexpected import status ${importDetail.status}`);
  }

  const inputAfterHashes = await hashFiles(fixtureInputs.map((item) => item.source));
  const inputIntegrity = beforeHashes.map((entry, index) => ({
    path: fixtureInputs[index].source,
    before: entry,
    after: inputAfterHashes[index],
    unchanged: entry === inputAfterHashes[index],
  }));
  if (inputIntegrity.some((entry) => !entry.unchanged)) {
    throw new Error("fixture input changed");
  }

  const db = new Database(join(DATA_ROOT, "db", "workbench.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  let sourceCounts;
  try {
    const pptxVersions = db
      .prepare(
        `SELECT sv.id, s.title, sv.extraction_snapshot_json
         FROM source_versions sv JOIN sources s ON s.id = sv.source_id
         WHERE s.kind = 'local_pptx'
         ORDER BY s.title`,
      )
      .all();
    const perSource = pptxVersions.map((row) => ({
      sourceVersionId: row.id,
      title: row.title,
      pages: count(db, "document_sections", "source_version_id", row.id),
      media: count(db, "adapter_local_ids", "source_version_id = ? AND entity_type = 'media'", row.id),
      occurrences: count(db, "occurrences", "source_version_id", row.id),
      snapshot: JSON.parse(row.extraction_snapshot_json),
    }));
    sourceCounts = {
      sourceVersionCount: pptxVersions.length,
      pages: perSource.reduce((sum, item) => sum + item.pages, 0),
      media: perSource.reduce((sum, item) => sum + item.media, 0),
      occurrences: perSource.reduce((sum, item) => sum + item.occurrences, 0),
      sources: perSource,
    };
    sourceCounts.documents = db
      .prepare(
        `SELECT COUNT(*) AS count FROM source_versions sv JOIN sources s ON s.id = sv.source_id
         WHERE s.kind LIKE 'local_%' AND s.kind <> 'local_file'`,
      )
      .get().count;
  } finally {
    db.close();
  }
  await writeFile(
    join(EVIDENCE, "source-counts.json"),
    `${JSON.stringify(sourceCounts, null, 2)}\n`,
  );
  if (
    sourceCounts.sourceVersionCount !== 2 ||
    sourceCounts.pages !== 46 ||
    sourceCounts.media !== 47 ||
    sourceCounts.occurrences !== 51 ||
    sourceCounts.documents !== 10
  ) {
    throw new Error(
      `PPTX/document count mismatch: ${JSON.stringify(sourceCounts)}`,
    );
  }

  const queries = JSON.parse(await readFile(QUERY_FILE, "utf8")).queries;
  if (queries.length !== 30) throw new Error("query fixture must contain 30 queries");
  const queryResults = [];
  for (const query of queries) {
    const response = await search(query.query);
    queryResults.push({
      id: query.id,
      query: query.query,
      expectedRefs: null,
      relevanceStatus: "pending_manual_label",
      indexGenerationId: response.data.indexGenerationId,
      capabilities: response.data.capabilities,
      hits: response.data.hits.slice(0, 5).map((hit) => ({
        refId: hit.refId,
        refType: hit.refType,
        chunkId: hit.chunkId,
        sourceVersionId: hit.sourceVersionId,
        sourceTitle: hit.sourceTitle,
        keywordRank: hit.keywordRank,
        matchedText: hit.matchedText,
        blockIds: hit.blockIds,
        selectionHandle: hit.selectionHandle,
      })),
    });
  }
  await writeFile(
    join(EVIDENCE, "search-30.json"),
    `${JSON.stringify(queryResults, null, 2)}\n`,
  );

  const twoChar = await search("销量");
  const singleChar = await search("销");
  const injection = await search("' OR 1=1 --");
  const inventory = await search("库存查询");
  const selectionHit = inventory.data.hits.find((hit) => hit.blockIds.length > 0);
  if (selectionHit === undefined) throw new Error("no selectable source hit");
  const selection = await api(
    "GET",
    `/api/v1/selections/${selectionHit.selectionHandle}`,
  );

  const assets = await api("GET", "/api/v1/assets?limit=100");
  const patchAsset = assets.data.items[0];
  if (patchAsset === undefined) throw new Error("no asset to patch");
  const manualTitle = `验收人工标题-${patchAsset.id.slice(0, 8)}`;
  const patchResponse = await fetch(`${base}/api/v1/assets/${patchAsset.id}`, {
    method: "PATCH",
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({
      schemaVersion: 1,
      expectedVersion: patchAsset.version,
      title: manualTitle,
      tags: ["验收"],
    }),
  });
  if (patchResponse.status !== 200) {
    throw new Error(`asset patch failed: ${patchResponse.status}`);
  }
  const manualSearch = await search(manualTitle);
  const manualTagSearch = await search("验收");
  if (manualSearch.data.hits.length === 0) {
    throw new Error("manual title was not visible to keyword search");
  }
  if (manualTagSearch.data.hits.length === 0) {
    throw new Error("manual tags were not visible to keyword search");
  }
  const stale = await api(
    "GET",
    `/api/v1/selections/${selectionHit.selectionHandle}`,
    undefined,
    409,
  );
  if (stale.error.code !== "SEARCH_SELECTION_STALE") {
    throw new Error("old generation selection was not rejected as stale");
  }

  const pdfSource = sourceCounts.sources.find((item) => item.pages === 34) ??
    sourceCounts.sources[0];
  const sourceId = await sourceIdForVersion(pdfSource.sourceVersionId);
  const sourceDetail = await api(
    "GET",
    `/api/v1/sources/${sourceId}?versionId=${pdfSource.sourceVersionId}`,
  );
  const pageLocator = sourceDetail.data.document.sections[0].locator;
  const merchantA = randomUUID();
  const factText = "验收事实" + "值".repeat(1_196);
  const fact = await api("POST", "/api/v1/facts", {
    schemaVersion: 1,
    canonicalKey: `verify:${merchantA}`,
    version: {
      value: 1200,
      unit: "次",
      merchantId: merchantA,
      period: { start: "2026-01-01", end: "2026-01-31" },
      kind: "user_assertion",
      sourceVersionId: pdfSource.sourceVersionId,
      sourceLocator: pageLocator,
      status: "unverified",
      indexText: factText,
    },
  }, 201);
  const factSearch = await search("验收事实值值", merchantA);
  const factSelection = await api(
    "GET",
    `/api/v1/selections/${factSearch.data.hits[0].selectionHandle}`,
  );
  const wrongMerchant = await search("验收事实值值", randomUUID());
  const factInDate = await search("验收事实值值", merchantA, {
    dateFrom: "2026-01-15",
    dateTo: "2026-01-20",
  });
  const factOutDate = await search("验收事实值值", merchantA, {
    dateFrom: "2026-02-01",
    dateTo: "2026-02-28",
  });
  const factWrongMedia = await search("验收事实值值", merchantA, {
    mediaKinds: ["video"],
  });
  const factVersion2 = await api(
    "POST",
    `/api/v1/facts/${fact.data.id}/versions`,
    {
      schemaVersion: 1,
      expectedVersionId: fact.data.currentVersionId,
      version: {
        value: 1300,
        unit: "次",
        merchantId: merchantA,
        period: { start: "2026-01-01", end: "2026-01-31" },
        kind: "user_assertion",
        sourceVersionId: pdfSource.sourceVersionId,
        sourceLocator: pageLocator,
        status: "unverified",
        indexText: "验收事实新版本",
      },
    },
    201,
  );
  const factVersionSearch = await search("验收事实新版本", merchantA);
  const factRead = await api("GET", `/api/v1/facts/${fact.data.id}`);
  const wrongLocator = await api(
    "POST",
    "/api/v1/facts",
    {
      schemaVersion: 1,
      canonicalKey: `wrong-locator:${randomUUID()}`,
      version: {
        value: 1,
        unit: "个",
        merchantId: null,
        period: null,
        kind: "measured",
        sourceVersionId: pdfSource.sourceVersionId,
        sourceLocator: { kind: "page", page: 999 },
        indexText: "错误关系事实",
      },
    },
    422,
  );
  const tooLong = await api(
    "POST",
    "/api/v1/facts",
    {
      schemaVersion: 1,
      canonicalKey: `too-long:${randomUUID()}`,
      version: {
        value: "x",
        unit: "个",
        merchantId: null,
        period: null,
        kind: "measured",
        sourceVersionId: pdfSource.sourceVersionId,
        sourceLocator: pageLocator,
        indexText: "长".repeat(1_201),
      },
    },
    422,
  );
  if (
    Array.from(fact.data.currentVersion.indexText).length !== 1200 ||
    factSelection.data.fact.id !== fact.data.id ||
    wrongMerchant.data.hits.length !== 0 ||
    factInDate.data.hits.length === 0 ||
    factOutDate.data.hits.length !== 0 ||
    factWrongMedia.data.hits.length !== 0 ||
    factVersion2.data.currentVersion.version !== 2 ||
    factVersionSearch.data.hits[0]?.factId !== fact.data.id ||
    factRead.data.currentVersionId !== factVersion2.data.currentVersionId ||
    wrongLocator.error.code !== "UNKNOWN_REFERENCE" ||
    tooLong.error.code !== "VALIDATION_ERROR"
  ) {
    throw new Error("fact boundary or hard-filter verification failed");
  }

  await writeFile(
    join(EVIDENCE, "http-checks.json"),
    `${JSON.stringify({
      importStatus: importDetail.status,
      twoCharHits: twoChar.data.hits.length,
      singleCharHits: singleChar.data.hits.length,
      injectionHits: injection.data.hits.length,
      selectedBlocks: selection.data.blocks.map((block) => ({
        id: block.id,
        text: block.text,
        locator: block.locator,
      })),
      selectionDocumentUrl: selection.data.sourceDocumentUrl,
      manualTitle,
      manualTitleHits: manualSearch.data.hits.length,
      manualTagHits: manualTagSearch.data.hits.length,
      staleCode: stale.error.code,
      fact: fact.data,
      factSelectionFactId: factSelection.data.fact.id,
      wrongMerchantHits: wrongMerchant.data.hits.length,
      factInDateHits: factInDate.data.hits.length,
      factOutDateHits: factOutDate.data.hits.length,
      factWrongMediaHits: factWrongMedia.data.hits.length,
      factVersion2: factVersion2.data.currentVersion,
      factVersionSearchHits: factVersionSearch.data.hits.length,
      factReadVersion: factRead.data.currentVersion.version,
      wrongLocatorCode: wrongLocator.error.code,
      tooLongStatus: tooLong.error.code,
      inputIntegrity,
    }, null, 2)}\n`,
  );

  browser = await chromium.launch({
    headless: true,
    executablePath: await chromiumExecutable(),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`${base}/assets`);
  await page.locator("nav.topnav .capsule-link").first().waitFor();
  if (await page.locator("nav.topnav .capsule-link").count() !== 3) {
    throw new Error("top-level navigation is not three entries");
  }
  const importTrigger = page.getByRole("button", { name: /导入素材/ }).first();
  await importTrigger.click();
  await page.getByRole("button", { name: "上传文件或目录" }).click();
  const accept = await page.getByTestId("upload-files").getAttribute("accept");
  if (![".pdf", ".pptx", ".html", ".zip"].every((value) => accept?.includes(value))) {
    throw new Error("document formats are missing from upload picker");
  }
  await page.keyboard.press("Escape");
  await page.getByPlaceholder("搜索正文、标题或标签").fill("库存查询");
  await page.locator(".search-hit").first().waitFor({ timeout: 15_000 });
  const hitCount = await page.locator(".search-hit").count();
  await page.screenshot({
    path: join(ARTIFACT_ROOT, "search-1280.png"),
    fullPage: true,
  });
  await page.locator(".search-hit").first().click();
  await page.locator(".selection-overlay").waitFor();
  await page.screenshot({
    path: join(ARTIFACT_ROOT, "selection-1280.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "打开完整来源" }).click();
  await page.getByText("文档结构").waitFor();
  await page.screenshot({
    path: join(ARTIFACT_ROOT, "source-context-1280.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.pdf({
    path: join(ARTIFACT_ROOT, "search-results.pdf"),
    format: "A4",
    printBackground: true,
  });
  for (const width of [360, 728]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.getByPlaceholder("搜索正文、标题或标签").fill("库存查询");
    await page.locator(".search-hit").first().waitFor({ timeout: 15_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    if (overflow) throw new Error(`horizontal overflow at ${width}`);
    await page.screenshot({
      path: join(ARTIFACT_ROOT, `search-${width}.png`),
      fullPage: true,
    });
  }
  await context.close();
  await browser.close();
  browser = null;
  if (consoleErrors.length > 0) {
    throw new Error(`browser console errors: ${consoleErrors.join(" | ")}`);
  }
  state.e2e = "passed";

  const artifacts = await hashDirectory(ARTIFACT_ROOT);
  await writeFile(
    join(EVIDENCE, "artifact-hashes.json"),
    `${JSON.stringify({
      files: artifacts,
      browser: {
        hitCount,
        widths: [360, 728, 1280],
        importPickerAccept: accept,
        consoleErrors,
      },
    }, null, 2)}\n`,
  );

  state.test = "not_run_in_verify_script";
  state.check = "not_run_in_verify_script";
  await writeFile(
    join(EVIDENCE, "result.json"),
    `${JSON.stringify({ ...state, finishedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  process.stdout.write(`verification passed: ${EVIDENCE}\n`);
} catch (error) {
  state.e2e = state.e2e === "passed" ? "passed" : "failed";
  await writeFile(
    join(EVIDENCE, "result.json"),
    `${JSON.stringify({
      ...state,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      finishedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  ).catch(() => undefined);
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (server !== null) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await new Promise((resolve) => server.once("exit", resolve));
    }
  }
  await logHandle?.close();
  await writeFile(
    join(EVIDENCE, "process-cleanup.json"),
    `${JSON.stringify({
      serverPid: server?.pid ?? null,
      serverExitCode: server?.exitCode ?? null,
      serverSignal: server?.signalCode ?? null,
      port: base === "" ? null : Number(new URL(base).port),
      cleanupAt: new Date().toISOString(),
    }, null, 2)}\n`,
  ).catch(() => undefined);
}

async function prepareFixtures() {
  const names = (await readdir(INPUT_ROOT))
    .filter((name) => /^S\d+-.*\.(md|pptx)$/u.test(name))
    .sort();
  const inputs = [];
  for (const name of names) {
    const source = join(INPUT_ROOT, name);
    const destination = join(FIXTURE_ROOT, name);
    const cloned = spawnSync("cp", ["-c", source, destination]);
    if (cloned.status !== 0) await copyFile(source, destination);
    inputs.push({ source, destination });
  }
  if (inputs.filter((item) => item.destination.endsWith(".md")).length !== 8) {
    throw new Error("expected eight Markdown snapshots");
  }
  if (inputs.filter((item) => item.destination.endsWith(".pptx")).length !== 2) {
    throw new Error("expected two PPTX fixtures");
  }
  return inputs;
}

async function session() {
  const response = await fetch(`${base}/api/v1/health`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("session cookie missing");
  const body = await response.json();
  return {
    cookie: setCookie.split(";")[0] ?? "",
    csrf: body.data.csrfToken,
  };
}

async function api(method, path, body, expectedStatus = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: base,
      ...(method === "GET" ? {} : {
        "content-type": "application/json",
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
      }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

async function search(query, merchantId = null, overrides = {}) {
  return api("POST", "/api/v1/search", {
    schemaVersion: 1,
    query,
    mode: "keyword",
    limit: 20,
    filters: {
      schemaVersion: 1,
      merchantId,
      dateFrom: overrides.dateFrom ?? null,
      dateTo: overrides.dateTo ?? null,
      mediaKinds: overrides.mediaKinds ?? [],
      audience: [],
      functions: [],
      obsolete: "exclude",
      availability: [],
    },
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.ok) return;
    } catch {
    }
    await sleep(100);
  }
  throw new Error("server did not become ready");
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await sleep(150);
  }
  throw new Error("timed out waiting for result");
}

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function hashFiles(paths) {
  const hashes = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    hashes.push(createHash("sha256").update(bytes).digest("hex"));
  }
  return hashes;
}

async function hashDirectory(root) {
  const files = [];
  for (const name of (await readdir(root)).sort()) {
    const bytes = await readFile(join(root, name));
    files.push({
      path: relative(EVIDENCE, join(root, name)),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return files;
}

function count(db, table, condition, value) {
  const where = condition.includes("?") ? condition : `${condition} = ?`;
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(value).count;
}

async function sourceIdForVersion(sourceVersionId) {
  const sources = await api("GET", "/api/v1/sources?limit=100");
  const source = sources.data.items.find(
    (item) => item.currentVersionId === sourceVersionId,
  );
  if (source === undefined) throw new Error("source id missing for version");
  return source.id;
}

async function openLog(path) {
  const { createWriteStream } = await import("node:fs");
  const stream = createWriteStream(path);
  return {
    stream,
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}

async function chromiumExecutable() {
  const roots = (await readdir(PLAYWRIGHT_ROOT))
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const root of roots) {
    const candidate = join(
      PLAYWRIGHT_ROOT,
      root,
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell",
    );
    try {
      await readFile(candidate);
      return candidate;
    } catch {
    }
  }
  throw new Error("Chromium headless shell is not installed");
}

function isolatedEnv() {
  return {
    TMPDIR: join(EVIDENCE, "tmp"),
    XDG_CACHE_HOME: join(EVIDENCE, "cache"),
    npm_config_cache: join(EVIDENCE, "npm-cache"),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
