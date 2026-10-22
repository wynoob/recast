import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import {
  canonicalHash,
  computeThemeContrast,
  createSyntheticSample,
  renderTemplateSample,
  validateTemplatePackage,
} from "../dist/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examples = path.join(root, "examples");
const evidence = path.join(root, "evidence");
const pdfDir = path.join(evidence, "pdf");
const screenshotDir = path.join(evidence, "screenshots");
const chromiumPath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  "/Users/wangyun/Projects/recast/.tools/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForStablePage(page) {
  await page.waitForLoadState("load");
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.images);
    await Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            }),
      ),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function measureScreen(page) {
  return page.evaluate(() => {
    const missingResources = Array.from(document.images)
      .filter((image) => !image.complete || image.naturalWidth === 0)
      .map((image) => image.getAttribute("src") ?? "unknown");
    const activeContent = document.querySelector(".slide.is-active .slide-content");
    const activeOverflow =
      activeContent instanceof HTMLElement
        ? activeContent.scrollWidth > activeContent.clientWidth + 1 ||
          activeContent.scrollHeight > activeContent.clientHeight + 1
        : false;
    return {
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth + 1,
      activeOverflow,
      missingResources,
      imageCount: document.images.length,
      slideCount: document.querySelectorAll(".slide").length,
    };
  });
}

async function measurePrint(page, kind) {
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(50);
  const metrics = await page.evaluate((kindValue) => {
    const slides = Array.from(document.querySelectorAll(".slide"));
    const contents = Array.from(document.querySelectorAll(".slide-content"));
    const slideOverflow = contents.some(
      (element) =>
        element instanceof HTMLElement &&
        (element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1),
    ) ||
      slides.some(
        (slide) =>
          slide instanceof HTMLElement &&
          (slide.scrollWidth > slide.clientWidth + 1 ||
            slide.scrollHeight > slide.clientHeight + 1),
      );
    const paper = document.querySelector(".doc-paper");
    const docHorizontalOverflow =
      paper instanceof HTMLElement ? paper.scrollWidth > paper.clientWidth + 1 : false;
    return {
      slideCount: slides.length,
      slideOverflow,
      docHorizontalOverflow,
      renderedSlides: slides.filter(
        (slide) =>
          slide instanceof HTMLElement &&
          getComputedStyle(slide).display !== "none",
      ).length,
      kind: kindValue,
    };
  }, kind);
  return {
    ...metrics,
    overflow: kind === "html_deck" ? metrics.slideOverflow : metrics.docHorizontalOverflow,
  };
}

function countPdfPages(buffer) {
  const text = buffer.toString("latin1");
  return (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

async function main() {
  await fs.mkdir(evidence, { recursive: true });
  await fs.mkdir(pdfDir, { recursive: true });
  await fs.mkdir(screenshotDir, { recursive: true });
  const manifest = JSON.parse(
    await fs.readFile(path.join(examples, "manifest.json"), "utf8"),
  );
  const browser = await chromium.launchPersistentContext(path.join(root, "../browser/samples-profile"), {
    downloadsPath: path.join(root, "../browser/downloads"),
    tracesDir: path.join(root, "../browser/traces"),
    executablePath: chromiumPath,
    headless: true,
  });
  const results = [];
  let failed = false;
  try {
    for (const entry of manifest.entries) {
      const sample = createSyntheticSample(entry.narrativeId, entry.kind);
      const expectedRender = renderTemplateSample({
        instance: sample.instance,
        media: sample.mediaPaths,
      });
      const filePath = path.join(examples, entry.file);
      const fileHtml = await fs.readFile(filePath, "utf8");
      const fileHash = sha256(fileHtml);
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const externalRequests = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith("http://") || url.startsWith("https://")) {
          externalRequests.push(url);
        }
      });
      await page.goto(pathToFileURL(filePath).href);
      await waitForStablePage(page);
      const screen = await measureScreen(page);

      let navigationOk = true;
      if (entry.kind === "html_deck") {
        await page.locator("[data-next]").click();
        navigationOk = await page.locator(".slide.is-active").getAttribute("data-slide-index") === "1";
        await page.locator("[data-prev]").click();
        navigationOk =
          navigationOk &&
          (await page.locator(".slide.is-active").getAttribute("data-slide-index")) === "0";
      }

      if (entry.kind === "html_deck" || entry.narrativeId === "phase-review") {
        await page.screenshot({
          path: path.join(
            screenshotDir,
            `${entry.kind === "html_deck" ? "deck" : "doc"}-${entry.narrativeId}.png`,
          ),
          fullPage: true,
        });
      }

      const printMetrics = await measurePrint(page, entry.kind);
      const pdfPath = path.join(pdfDir, `${entry.kind}-${entry.narrativeId}.pdf`);
      const pdf = await page.pdf({
        path: pdfPath,
        printBackground: true,
        preferCSSPageSize: true,
      });
      const pdfPages = countPdfPages(pdf);
      await page.emulateMedia({ media: "screen" });

      const contrast = computeThemeContrast(sample.packageValue.theme);
      const ready = validateTemplatePackage(sample.packageValue, {
        mode: "ready",
        sample: {
          ast: sample.instance.ast,
          media: sample.mediaPaths,
        },
        instance: sample.instance,
        evidence: {
          source: "chromium",
          rendererVersion: sample.packageValue.rendererVersion,
          sampleHash: fileHash,
          templateHash: canonicalHash(sample.packageValue),
          astHash: canonicalHash(sample.instance.ast),
          loaded: true,
          missingResources: screen.missingResources,
          externalRequests,
          overflow: {
            screen: screen.horizontalOverflow || screen.activeOverflow,
            print: printMetrics.overflow,
          },
          print: {
            pages: pdfPages,
            pdfBytes: pdf.byteLength,
            pdfSha256: sha256(pdf),
          },
          contrast,
          checkedAt: new Date().toISOString(),
        },
        now: new Date().toISOString(),
      });

      const entryOk =
        entry.artifactHash === fileHash &&
        expectedRender.artifactHash === fileHash &&
        screen.missingResources.length === 0 &&
        !screen.horizontalOverflow &&
        !screen.activeOverflow &&
        !printMetrics.overflow &&
        externalRequests.length === 0 &&
        navigationOk &&
        ready.ok;
      if (!entryOk) failed = true;
      results.push({
        artifactId: entry.artifactId,
        file: entry.file,
        artifactHash: fileHash,
        expectedHash: entry.artifactHash,
        rendererVersion: sample.packageValue.rendererVersion,
        screen,
        print: printMetrics,
        pdf: {
          path: path.relative(root, pdfPath),
          pages: pdfPages,
          bytes: pdf.byteLength,
          sha256: sha256(pdf),
          header: pdf.subarray(0, 5).toString("ascii"),
        },
        externalRequests,
        navigationOk,
        contrast,
        readyReview: ready.readyReview,
        readyOk: ready.ok,
        issues: ready.issues,
        ok: entryOk,
      });
      await page.close();
      console.log(
        `${entryOk ? "PASS" : "FAIL"} ${entry.artifactId} pages=${pdfPages} hash=${fileHash.slice(0, 12)}`,
      );
    }

    const negativeOverflow = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const overflowPath = path.join(examples, manifest.negatives.overflow.file);
    await negativeOverflow.goto(pathToFileURL(overflowPath).href);
    await waitForStablePage(negativeOverflow);
    const overflowMetrics = await measurePrint(negativeOverflow, "html_deck");
    await negativeOverflow.close();

    const negativeMissing = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const missingPath = path.join(examples, manifest.negatives.missing.file);
    await negativeMissing.goto(pathToFileURL(missingPath).href);
    await waitForStablePage(negativeMissing);
    const missingMetrics = await measureScreen(negativeMissing);
    await negativeMissing.close();

    const negativeChecks = {
      overflow: {
        detected: overflowMetrics.overflow,
        metrics: overflowMetrics,
      },
      missing: {
        detected: missingMetrics.missingResources.length > 0,
        metrics: missingMetrics,
      },
    };
    if (!negativeChecks.overflow.detected || !negativeChecks.missing.detected) {
      failed = true;
    }

    const galleryPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const galleryRequests = [];
    galleryPage.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        galleryRequests.push(url);
      }
    });
    await galleryPage.goto(pathToFileURL(path.join(examples, "index.html")).href);
    await waitForStablePage(galleryPage);
    const galleryMetrics = await measureScreen(galleryPage);
    await galleryPage.screenshot({
      path: path.join(screenshotDir, "gallery.png"),
      fullPage: true,
    });
    await galleryPage.close();
    if (galleryMetrics.horizontalOverflow || galleryRequests.length > 0) {
      failed = true;
    }

    const result = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      chromium: {
        executablePath: chromiumPath,
        headless: true,
      },
      samples: results,
      negatives: negativeChecks,
      gallery: {
        metrics: galleryMetrics,
        externalRequests: galleryRequests,
        screenshot: "evidence/screenshots/gallery.png",
      },
      ok: !failed,
    };
    await fs.writeFile(
      path.join(evidence, "browser-results.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    if (failed) {
      throw new Error("browser verification failed; see evidence/browser-results.json");
    }
    console.log(
      `browser verification passed: ${results.length} samples, overflow negative detected, missing negative detected`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
