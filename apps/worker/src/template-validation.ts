import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";
import {
  canonicalHash,
  computeThemeContrast,
  createTemplateValidationSample,
  renderTemplateSample,
  validateTemplatePackage,
} from "@dmall/templates";
import type {
  JobGrant,
  JobResult,
  ReadyRenderEvidence,
  TemplateValidationResult,
  ValidationIssue,
} from "@dmall/contracts";
import { WorkerTaskError } from "./task-error.js";

const IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#241c50"/><circle cx="720" cy="170" r="150" fill="#6d3fe0"/><path d="M80 430 310 200l160 145 120-105 290 240H80Z" fill="#f7f4ff" opacity=".9"/></svg>`;

export async function runTemplateValidation(
  grant: JobGrant,
  signal: AbortSignal,
): Promise<JobResult> {
  if (grant.input.jobType !== "template_validate") {
    throw new WorkerTaskError("INTERNAL_ERROR", "模板验证任务输入类型不匹配");
  }
  if (grant.workspacePath === undefined) {
    throw new WorkerTaskError("INTERNAL_ERROR", "模板验证任务缺少独立工作目录");
  }
  const workspace = resolve(grant.workspacePath);
  await mkdir(join(workspace, "assets"), { recursive: true });
  const pkg = grant.input.templatePackage;
  const templateHash = canonicalHash(pkg);
  if (templateHash !== grant.input.templateHash) {
    throw new WorkerTaskError("TEMPLATE_INVALID", "模板包 hash 与任务输入不一致");
  }

  let sample: ReturnType<typeof createTemplateValidationSample>;
  try {
    sample = createTemplateValidationSample(pkg);
  } catch (error) {
    const draft = validateTemplatePackage(pkg);
    const issue: ValidationIssue = {
      code: "SAMPLE_INSTANTIATION_FAILED",
      path: "sample",
      message: error instanceof Error ? error.message : "模板验证样例无法实例化",
    };
    const validation = failedValidation(draft, issue);
    return failureResult(grant, validation, issue.message);
  }
  const render = renderTemplateSample({
    instance: sample.instance,
    media: sample.mediaPaths,
  });
  if (!render.ok) {
    const draft = validateTemplatePackage(pkg);
    const validation = failedValidation(draft, ...render.issues);
    return failureResult(
      grant,
      validation,
      render.issues.map((item) => item.message).join("；"),
    );
  }

  const htmlPath = join(workspace, "sample.html");
  const pdfPath = join(workspace, "sample.pdf");
  const screenshotPath = join(workspace, "screen.png");
  await writeFile(htmlPath, render.html, "utf8");
  await writeFile(join(workspace, "assets", "validation-image.svg"), IMAGE_SVG, "utf8");
  await writeFile(join(workspace, "assets", "validation-poster.svg"), IMAGE_SVG, "utf8");

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath === undefined || executablePath === ""
      ? {}
      : { executablePath }),
  });
  const closeOnAbort = (): void => {
    void browser.close();
  };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        externalRequests.push(url);
      }
    });
    await page.goto(pathToFileURL(htmlPath).href);
    await waitForStablePage(page);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screen = await measureScreen(page);
    const print = await measurePrint(page, pkg.manifest.kind);
    const pdf = await page.pdf({
      path: pdfPath,
      printBackground: true,
      preferCSSPageSize: true,
    });
    await page.emulateMedia({ media: "screen" });
    if (signal.aborted) throw new WorkerTaskError("JOB_CANCELLED", "模板验证已取消");

    const htmlHash = sha256(render.html);
    const evidence: ReadyRenderEvidence = {
      source: "chromium",
      rendererVersion: pkg.rendererVersion,
      sampleHash: htmlHash,
      templateHash,
      astHash: canonicalHash(sample.instance.ast),
      loaded: true,
      missingResources: screen.missingResources,
      externalRequests,
      overflow: {
        screen: screen.horizontalOverflow || screen.activeOverflow,
        print: print.overflow,
      },
      print: {
        pages: countPdfPages(pdf),
        pdfBytes: pdf.byteLength,
        pdfSha256: sha256(pdf),
      },
      contrast: computeThemeContrast(pkg.theme),
      checkedAt: new Date().toISOString(),
    };
    const validation = validateTemplatePackage(pkg, {
      mode: "ready",
      sample: { ast: sample.instance.ast, media: sample.mediaPaths },
      instance: sample.instance,
      evidence,
      now: evidence.checkedAt,
    });
    const result: JobResult = {
      schemaVersion: 1,
      jobType: "template_validate",
      templateVersionId: grant.input.templateVersionId,
      templateHash,
      ok: validation.ok,
      message: validation.ok
        ? "模板验证通过"
        : validation.issues.map((item) => item.message).join("；"),
      astHash: evidence.astHash,
      sampleHash: evidence.sampleHash,
      instance: sample.instance,
      sample: { ast: sample.instance.ast, media: sample.mediaPaths },
      evidence,
      validation,
      artifacts: {
        htmlPath: relative(workspace, htmlPath),
        pdfPath: relative(workspace, pdfPath),
        screenshotPath: relative(workspace, screenshotPath),
      },
    };
    return result;
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await browser.close();
  }
}

function failureResult(
  grant: JobGrant,
  validation: TemplateValidationResult,
  message: string,
): JobResult {
  if (grant.input.jobType !== "template_validate") {
    throw new WorkerTaskError("INTERNAL_ERROR", "模板验证任务输入类型不匹配");
  }
  return {
    schemaVersion: 1,
    jobType: "template_validate",
    templateVersionId: grant.input.templateVersionId,
    templateHash: grant.input.templateHash,
    ok: false,
    message,
    astHash: null,
    sampleHash: null,
    instance: null,
    sample: null,
    evidence: null,
    validation,
    artifacts: null,
  };
}

function failedValidation(
  base: TemplateValidationResult,
  ...issues: ValidationIssue[]
): TemplateValidationResult {
  const merged = [...base.issues, ...issues];
  return {
    ...base,
    ok: false,
    issues: merged,
    readyReview: {
      decision: "blocked",
      recommendedStatus: null,
      generatedAt: new Date().toISOString(),
      checks: [
        ...base.checks,
        {
          id: "sample-instantiation",
          label: "验证样例实例化",
          ok: false,
          detail: issues.map((item) => item.message).join("；"),
        },
      ],
      evidenceHash: null,
    },
  };
}

async function waitForStablePage(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.images);
    await Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolveImage) => {
              image.addEventListener("load", resolveImage, { once: true });
              image.addEventListener("error", resolveImage, { once: true });
            }),
      ),
    );
    await new Promise((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
    );
  });
}

async function measureScreen(page: Page): Promise<{
  horizontalOverflow: boolean;
  activeOverflow: boolean;
  missingResources: string[];
}> {
  const measureActive = () => page.evaluate(() => {
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
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      activeOverflow,
      missingResources,
    };
  });
  const initial = await measureActive();
  const slideCount = await page.locator(".slide").count();
  if (slideCount === 0) return initial;
  const missing = new Set(initial.missingResources);
  let horizontalOverflow = initial.horizontalOverflow;
  let activeOverflow = initial.activeOverflow;
  for (let index = 1; index < slideCount; index += 1) {
    await page.locator("[data-next]").click();
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ));
    const current = await measureActive();
    horizontalOverflow = horizontalOverflow || current.horizontalOverflow;
    activeOverflow = activeOverflow || current.activeOverflow;
    for (const resource of current.missingResources) missing.add(resource);
  }
  return {
    horizontalOverflow,
    activeOverflow,
    missingResources: [...missing],
  };
}

async function measurePrint(
  page: Page,
  kind: "feishu_doc" | "html_deck",
): Promise<{ overflow: boolean }> {
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(50);
  const metrics = await page.evaluate((kindValue) => {
    const slides = Array.from(document.querySelectorAll(".slide"));
    const contents = Array.from(document.querySelectorAll(".slide-content"));
    const slideOverflow =
      contents.some(
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
      overflow: kindValue === "html_deck" ? slideOverflow : docHorizontalOverflow,
    };
  }, kind);
  return metrics;
}

function countPdfPages(buffer: Buffer): number {
  const text = buffer.toString("latin1");
  return (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
