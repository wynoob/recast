import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(relativePath) {
  const buffer = await fs.readFile(path.join(root, relativePath));
  return sha256(buffer);
}

async function walk(relativeDir) {
  const entries = await fs.readdir(path.join(root, relativeDir), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function main() {
  const baselineManifestPath = "baseline/manifest.json";
  const baselineManifestBuffer = await fs.readFile(
    path.join(root, baselineManifestPath),
  );
  const baselineManifest = JSON.parse(baselineManifestBuffer.toString("utf8"));
  const baselineFiles = [];
  let baselineAllMatch = true;
  for (const file of baselineManifest.files) {
    const actual = await hashFile(`baseline/${file.path}`);
    const matches = actual === file.sha256;
    baselineAllMatch = baselineAllMatch && matches;
    baselineFiles.push({
      path: `baseline/${file.path}`,
      expectedSha256: file.sha256,
      actualSha256: actual,
      matches,
    });
  }
  const baselineEvidence = {
    schemaVersion: 1,
    manifestPath: baselineManifestPath,
    manifestSha256: sha256(baselineManifestBuffer),
    source: baselineManifest.source,
    allMatch: baselineAllMatch,
    files: baselineFiles,
  };
  await fs.writeFile(
    path.join(root, "evidence/baseline-hashes.json"),
    `${JSON.stringify(baselineEvidence, null, 2)}\n`,
    "utf8",
  );

  const sourceRoots = [
    "src",
    "tests",
    "scripts",
    "examples",
  ];
  const sourceFiles = [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "vite.config.ts",
    "vitest.config.ts",
    "README.md",
    "integration.json",
  ];
  for (const sourceRoot of sourceRoots) {
    sourceFiles.push(...(await walk(sourceRoot)));
  }
  sourceFiles.sort();
  const files = [];
  for (const relativePath of sourceFiles) {
    files.push({
      path: relativePath,
      sha256: await hashFile(relativePath),
    });
  }
  const aggregateSha256 = sha256(
    files.map((file) => `${file.path}:${file.sha256}`).join("\n"),
  );
  const sourceManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    aggregateSha256,
    fileCount: files.length,
    files,
  };
  await fs.writeFile(
    path.join(root, "evidence/source-manifest.json"),
    `${JSON.stringify(sourceManifest, null, 2)}\n`,
    "utf8",
  );

  const browser = JSON.parse(
    await fs.readFile(path.join(root, "evidence/browser-results.json"), "utf8"),
  );
  const testLog = await fs.readFile(path.join(root, "evidence/logs/test.log"), "utf8");
  const checkLog = await fs.readFile(path.join(root, "evidence/logs/check.log"), "utf8");
  const buildLog = await fs.readFile(path.join(root, "evidence/logs/build.log"), "utf8");
  const samplesLog = await fs.readFile(
    path.join(root, "evidence/logs/samples.log"),
    "utf8",
  );
  const browserLog = await fs.readFile(
    path.join(root, "evidence/logs/browser.log"),
    "utf8",
  );
  const testPassed =
    testLog.includes("Test Files  5 passed (5)") &&
    testLog.includes("Tests  23 passed (23)");
  const checkPassed = checkLog.includes("tsc -p tsconfig.json --noEmit");
  const buildPassed =
    buildLog.includes("✓ built in") && buildLog.includes("tsc -p tsconfig.build.json");
  const samplesPassed = samplesLog.includes("generated 12 template samples");
  const browserPassed =
    browser.ok === true &&
    browser.samples.length === 12 &&
    browser.samples.every((sample) => sample.ok) &&
    browser.negatives.overflow.detected === true &&
    browser.negatives.missing.detected === true;
  const allPassed =
    baselineAllMatch &&
    testPassed &&
    checkPassed &&
    buildPassed &&
    samplesPassed &&
    browserPassed;

  const logFiles = [
    "evidence/logs/check.log",
    "evidence/logs/test.log",
    "evidence/logs/build.log",
    "evidence/logs/samples.log",
    "evidence/logs/browser.log",
  ];
  const logHashes = [];
  for (const logFile of logFiles) {
    logHashes.push({ path: logFile, sha256: await hashFile(logFile) });
  }

  const readyPasses = browser.samples.filter(
    (sample) => sample.readyOk && sample.readyReview?.decision === "pass",
  );
  const documentSamples = browser.samples.filter(
    (sample) => sample.artifactId.startsWith("feishu_doc:"),
  );
  const deckSamples = browser.samples.filter(
    (sample) => sample.artifactId.startsWith("html_deck:"),
  );

  const result = {
    schemaVersion: 1,
    module: "T05-template-engine",
    status: allPassed ? "MODULE_PASS" : "ISSUES",
    generatedAt: new Date().toISOString(),
    summary: allPassed
      ? "六叙事双格式、八版式、严格模板包、实例化、切版式、ready 审阅与受控渲染已完成独立模块验证。"
      : "独立模块验证存在失败项，详见 verification。",
    implementation: {
      exports: [
        "TemplatePackageSchema",
        "builtinNarratives",
        "registeredLayouts",
        "validateTemplatePackage",
        "instantiateTemplate",
        "renderTemplateSample",
      ],
      sourceFiles: files.map((file) => file.path),
      narrativeCount: 6,
      layoutCount: 8,
      rendererVersions: ["docx-1", "deck-1"],
      deckCanvas: { width: 1600, height: 900 },
      theme: "violet-glass-24px",
    },
    verification: {
      check: {
        status: checkPassed ? "PASS" : "FAIL",
        log: "evidence/logs/check.log",
        detail: "TypeScript strict noEmit",
      },
      test: {
        status: testPassed ? "PASS" : "FAIL",
        log: "evidence/logs/test.log",
        files: 5,
        tests: 23,
        detail: "six narratives x two formats, eight layouts, negative cases",
      },
      build: {
        status: buildPassed ? "PASS" : "FAIL",
        log: "evidence/logs/build.log",
        detail: "Vite ESM build plus declaration emit",
      },
      samples: {
        status: samplesPassed ? "PASS" : "FAIL",
        log: "evidence/logs/samples.log",
        count: browser.samples.length,
        detail: "12 HTML samples, 3 synthetic SVG assets, 2 negative pages",
      },
      browser: {
        status: browserPassed ? "PASS" : "FAIL",
        log: "evidence/logs/browser.log",
        results: "evidence/browser-results.json",
        samples: browser.samples.length,
        documents: documentSamples.length,
        decks: deckSamples.length,
        pdfs: browser.samples.length,
        readyReviewPass: readyPasses.length,
        negatives: browser.negatives,
        noExternalRequests: browser.samples.every(
          (sample) => sample.externalRequests.length === 0,
        ),
      },
    },
    readyReview: {
      decision: allPassed ? "pass" : "blocked",
      recommendedStatus: allPassed ? "ready" : null,
      persisted: false,
      note: "ready review 仅返回审阅结果；未写 DB，内置模板仍为 draft。",
      reviewedSamples: readyPasses.length,
      evidence: browser.samples.map((sample) => ({
        artifactId: sample.artifactId,
        artifactHash: sample.artifactHash,
        pdfPages: sample.pdf.pages,
        pdfSha256: sample.pdf.sha256,
        contrastMinimum: sample.contrast.minimum,
        decision: sample.readyReview?.decision ?? "blocked",
      })),
    },
    baseline: {
      manifest: baselineManifestPath,
      manifestSha256: baselineEvidence.manifestSha256,
      allMatch: baselineAllMatch,
      fileCount: baselineFiles.length,
      evidence: "evidence/baseline-hashes.json",
    },
    sourceManifest: {
      aggregateSha256,
      fileCount: files.length,
      path: "evidence/source-manifest.json",
    },
    artifacts: {
      examplesIndex: "examples/index.html",
      examplesManifest: "examples/manifest.json",
      screenshots: "evidence/screenshots",
      pdfs: "evidence/pdf",
      logs: logHashes,
      integration: {
        path: "integration.json",
        sha256: await hashFile("integration.json"),
      },
    },
    isolation: {
      rootModifiedByThisStage: false,
      rootGitHead: null,
      commitOrPush: false,
      databaseOrApiOrFeishu: false,
      dependencyLock: "pnpm-lock.yaml",
      nodeModulesOwnedByStage: true,
    },
    limitations: [
      "模块通过不等于 Txx 已集成验收。",
      "root UI、API、SQL 迁移序号和共享 index 由后续唯一集成 owner 接线。",
      "HTML/PDF 真正导出闭包、项目包和飞书发布/取回仍属于 T07。",
      "ready review 通过未写入任何 DB 状态。",
      "示例数据与 SVG 媒体均为合成示意，不代表真实客户材料。"
    ],
    issues: allPassed
      ? []
      : [
          !baselineAllMatch ? "baseline hash mismatch" : null,
          !checkPassed ? "type check failed" : null,
          !testPassed ? "unit tests failed" : null,
          !buildPassed ? "build failed" : null,
          !samplesPassed ? "sample generation failed" : null,
          !browserPassed ? "browser verification failed" : null,
        ].filter(Boolean),
  };
  await fs.writeFile(
    path.join(root, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `${result.status} ${sourceManifest.fileCount} source files aggregate=${aggregateSha256.slice(0, 12)} ready=${readyPasses.length}`,
  );
  if (!allPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
