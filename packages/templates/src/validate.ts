import type { Ast, Block } from "@dmall/contracts";
import {
  ReadyRenderEvidenceSchema,
  TemplatePackageSchema,
  ValidateTemplateOptionsSchema,
  type ReadyReview,
  type TemplatePackage,
  type TemplateValidationResult,
  type ValidationCheck,
  type ValidationIssue,
} from "@dmall/contracts";
import { registeredLayouts } from "./catalog.js";
import { computeThemeContrast, renderTemplateSample } from "./render.js";
import { validateExportReadiness } from "./layouts.js";
import { validateAst } from "@dmall/domain";
import { validatePlacedSlot } from "./slot-content.js";
import { canonicalHash, sha256Hex } from "./ids.js";

const MIN_CONTRAST = 4.5;

const CUSTOMER_RESIDUAL_PATTERNS = [
  /[¥￥$]\s*\d/,
  /\d[\d,.]*\s*(?:元|万元|折|元\/)/,
  /(?:\u62a5\u4ef7|\u5408\u540c\u4ef7|\u6210\u4ea4\u4ef7|\u95e8\u5e97\u53f7|\u5546\u5bb6\u7f16\u7801)/,
  /merchant[-_ ]?id\s*[:=]/i,
];

function issue(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, path, message };
}

function check(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
): ValidationCheck {
  return { id, label, ok, detail };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameRegisteredLayout(pkg: TemplatePackage): string[] {
  const errors: string[] = [];
  for (const layout of pkg.layouts) {
    const registered = registeredLayouts.find((item) => item.id === layout.id);
    if (registered === undefined) {
      errors.push(`版式未在全局注册表: ${layout.id}`);
      continue;
    }
    if (canonical(layout) !== canonical(registered)) {
      errors.push(`版式定义与全局注册表不一致: ${layout.id}`);
    }
  }
  return errors;
}

function collectPackageText(pkg: TemplatePackage): { path: string; text: string }[] {
  const values: { path: string; text: string }[] = [];
  values.push({ path: "manifest.name", text: pkg.manifest.name });
  values.push({ path: "manifest.changeSummary", text: pkg.manifest.changeSummary });
  values.push({ path: "theme.name", text: pkg.theme.name });
  values.push({ path: "narrative.name", text: pkg.narrative.name });
  values.push({ path: "narrative.summary", text: pkg.narrative.summary });
  for (const [index, section] of pkg.narrative.doc.sections.entries()) {
    values.push({ path: `narrative.doc.sections[${index}].title`, text: section.title });
    values.push({ path: `narrative.doc.sections[${index}].purpose`, text: section.purpose });
  }
  for (const [index, slide] of pkg.narrative.deck.slides.entries()) {
    values.push({ path: `narrative.deck.slides[${index}].title`, text: slide.title });
    values.push({ path: `narrative.deck.slides[${index}].purpose`, text: slide.purpose });
  }
  for (const [index, layout] of pkg.layouts.entries()) {
    values.push({ path: `layouts[${index}].name`, text: layout.name });
    values.push({ path: `layouts[${index}].description`, text: layout.description });
  }
  for (const [index, slot] of pkg.slots.entries()) {
    values.push({ path: `slots[${index}].label`, text: slot.label });
    if (slot.source.kind === "default") {
      const value = slot.source.value;
      if (value.kind === "text") {
        values.push({ path: `slots[${index}].default.text`, text: value.text });
      } else if (value.kind === "list") {
        for (const [itemIndex, item] of value.items.entries()) {
          values.push({
            path: `slots[${index}].default.items[${itemIndex}]`,
            text: item,
          });
        }
      } else {
        for (const [columnIndex, column] of value.columns.entries()) {
          values.push({
            path: `slots[${index}].default.columns[${columnIndex}]`,
            text: column,
          });
        }
        for (const [rowIndex, row] of value.rows.entries()) {
          for (const [cellIndex, cell] of row.entries()) {
            values.push({
              path: `slots[${index}].default.rows[${rowIndex}][${cellIndex}]`,
              text: cell,
            });
          }
        }
      }
    }
  }
  return values;
}

function blockText(block: Block): string[] {
  switch (block.type) {
    case "heading":
      return [block.text];
    case "paragraph":
    case "callout":
      return block.inlines.map((inline) => inline.text);
    case "list":
      return block.items.flatMap((item) => item.map((inline) => inline.text));
    case "table":
      return [
        ...block.columns,
        ...block.rows.flatMap((row) => row.flatMap((cell) => cell.map((inline) => inline.text))),
      ];
    case "image":
    case "video":
      return [block.caption];
    case "readonly_source_block":
      return [block.summary];
    case "divider":
      return [];
  }
}

function collectAstText(ast: Ast): { path: string; text: string }[] {
  const values: { path: string; text: string }[] = [
    { path: "ast.title", text: ast.title },
  ];
  if (ast.kind === "feishu_doc") {
    for (const [sectionIndex, section] of ast.sections.entries()) {
      values.push({
        path: `ast.sections[${sectionIndex}].title`,
        text: section.title,
      });
      for (const [blockIndex, block] of section.blocks.entries()) {
        for (const [textIndex, text] of blockText(block).entries()) {
          values.push({
            path: `ast.sections[${sectionIndex}].blocks[${blockIndex}].text[${textIndex}]`,
            text,
          });
        }
      }
    }
  } else {
    for (const [slideIndex, slide] of ast.slides.entries()) {
      values.push({
        path: `ast.slides[${slideIndex}].title`,
        text: slide.title,
      });
      for (const [blockIndex, block] of slide.blocks.entries()) {
        for (const [textIndex, text] of blockText(block).entries()) {
          values.push({
            path: `ast.slides[${slideIndex}].blocks[${blockIndex}].text[${textIndex}]`,
            text,
          });
        }
      }
    }
  }
  return values;
}

function findResiduals(values: { path: string; text: string }[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const value of values) {
    const matched = CUSTOMER_RESIDUAL_PATTERNS.find((pattern) =>
      pattern.test(value.text),
    );
    if (matched !== undefined) {
      issues.push(
        issue(
          "CUSTOMER_RESIDUAL",
          value.path,
          `模板内容疑似包含客户价格或商家专属数据: ${matched.source}`,
        ),
      );
    }
  }
  return issues;
}

function failedResult(
  mode: TemplateValidationResult["mode"],
  pkg: TemplatePackage | null,
  checks: ValidationCheck[],
  issues: ValidationIssue[],
  review: ReadyReview | null,
): TemplateValidationResult {
  return {
    ok: false,
    mode,
    package: pkg,
    checks,
    issues,
    readyReview: review,
  };
}

export function validateTemplatePackage(
  input: unknown,
  optionsInput?: unknown,
): TemplateValidationResult {
  const optionsParsed = ValidateTemplateOptionsSchema.safeParse(optionsInput ?? {});
  const fallbackMode: TemplateValidationResult["mode"] = "draft";
  if (!optionsParsed.success) {
    return failedResult(
      fallbackMode,
      null,
      [check("options", "验证选项", false, "验证选项结构无效")],
      optionsParsed.error.issues.map((item) =>
        issue(
          "OPTIONS_INVALID",
          item.path.map(String).join("."),
          item.message,
        ),
      ),
      null,
    );
  }
  const options = optionsParsed.data;
  const parsed = TemplatePackageSchema.safeParse(input);
  if (!parsed.success) {
    return failedResult(
      options.mode,
      null,
      [check("schema", "模板包结构", false, "模板包未通过严格 schema")],
      parsed.error.issues.map((item) =>
        issue(
          "SCHEMA_INVALID",
          item.path.map(String).join("."),
          item.message,
        ),
      ),
      null,
    );
  }
  const pkg = parsed.data;
  const checks: ValidationCheck[] = [
    check("schema", "模板包结构", true, "严格 schema 通过"),
    check(
      "narratives",
      "双格式叙事映射",
      pkg.narrative.doc.sections.length > 0 &&
        pkg.narrative.deck.slides.length > 0,
      `文档章节 ${pkg.narrative.doc.sections.length} 个，演示页 ${pkg.narrative.deck.slides.length} 个`,
    ),
    check(
      "customer-defaults",
      "客户默认值",
      pkg.manifest.customerSpecificDefaults === false,
      "模板不含客户专属默认值",
    ),
  ];
  const issues: ValidationIssue[] = [];

  if (options.mode === "schema") {
    return {
      ok: true,
      mode: options.mode,
      package: pkg,
      checks,
      issues,
      readyReview: null,
    };
  }

  const layoutErrors = sameRegisteredLayout(pkg);
  checks.push(
    check(
      "layouts",
      "受控版式注册",
      layoutErrors.length === 0,
      layoutErrors.length === 0
        ? pkg.manifest.kind === "html_deck"
          ? `${pkg.layouts.length} 个版式与全局注册表一致`
          : "文档模板不声明演示版式"
        : layoutErrors.join("；"),
    ),
  );
  issues.push(
    ...layoutErrors.map((message, index) =>
      issue("LAYOUT_REGISTRATION_INVALID", `layouts[${index}]`, message),
    ),
  );

  const missingCapacities = pkg.slots.filter((slot) => {
    if (slot.blockType === "paragraph" || slot.blockType === "callout") {
      return slot.capacity.maxCharacters === undefined;
    }
    if (slot.blockType === "list") return slot.capacity.maxItems === undefined;
    if (slot.blockType === "table") return slot.capacity.maxRows === undefined;
    return false;
  });
  checks.push(
    check(
      "slot-capacities",
      "字段容量",
      missingCapacities.length === 0,
      missingCapacities.length === 0
        ? "所有文本、列表、表格槽位均有容量"
        : missingCapacities.map((slot) => slot.id).join("、"),
    ),
  );
  for (const slot of missingCapacities) {
    issues.push(issue("SLOT_CAPACITY_UNDEFINED", `slots.${slot.id}`, "槽位缺少容量"));
  }

  const requiredSlots = pkg.slots.filter((slot) => slot.required);
  checks.push(
    check(
      "required-sources",
      "必填槽位来源",
      requiredSlots.every((slot) => slot.source.kind !== "default" || slot.source.value !== undefined),
      `${requiredSlots.length} 个必填槽位均声明输入来源或默认值`,
    ),
  );

  const packageResiduals = findResiduals(collectPackageText(pkg));
  checks.push(
    check(
      "package-residuals",
      "客户数据残留",
      packageResiduals.length === 0,
      packageResiduals.length === 0 ? "模板包未发现价格或商家专属数据" : "发现可疑客户数据",
    ),
  );
  issues.push(...packageResiduals);

  if (options.mode === "draft") {
    return {
      ok: issues.length === 0,
      mode: options.mode,
      package: pkg,
      checks,
      issues,
      readyReview: null,
    };
  }

  if (pkg.manifest.status === "archived") {
    issues.push(
      issue("TEMPLATE_ARCHIVED", "manifest.status", "归档模板不能验证为 ready"),
    );
    checks.push(check("status", "模板状态", false, "模板已归档"));
  } else {
    checks.push(check("status", "模板状态", true, pkg.manifest.status));
  }

  const sample = options.sample;
  const instance = options.instance;
  checks.push(
    check(
      "sample",
      "样例输入",
      sample !== undefined && instance !== undefined,
      sample !== undefined && instance !== undefined
        ? "已提供样例 AST 与实例"
        : "ready 校验必须提供真实样例 AST 与实例",
    ),
  );
  if (sample === undefined || instance === undefined) {
    issues.push(
      issue(
        "SAMPLE_RENDER_EVIDENCE_REQUIRED",
        "options.sample",
        "ready 校验需要 instance 与样例 AST",
      ),
    );
  } else {
    if (
      canonicalHash(instance.templateSnapshot) !== canonicalHash(pkg)
    ) {
      issues.push(
        issue(
          "SAMPLE_TEMPLATE_SNAPSHOT_MISMATCH",
          "options.instance.templateSnapshot",
          "样例实例固定的整个模板规范与待审模板不一致",
        ),
      );
    }
    if (canonical(instance.ast) !== canonical(sample.ast)) {
      issues.push(
        issue(
          "SAMPLE_AST_MISMATCH",
          "options.sample.ast",
          "样例 AST 与实例 AST 不一致",
        ),
      );
    }
    const readiness = validateExportReadiness({ instance });
    checks.push(
      check(
        "export-readiness",
        "未放置块",
        readiness.ok,
        readiness.ok ? "样例没有未放置块" : readiness.issues.map((item) => item.message).join("；"),
      ),
    );
    if (!readiness.ok) issues.push(...readiness.issues);

    const astValidation = validateAst(instance.ast);
    if (!astValidation.ok) issues.push(...astValidation.violations.map(v => issue(v.code, "options.instance.ast", v.message)));
    const render = renderTemplateSample({
      templatePackage: pkg,
      ast: instance.ast,
      media: sample.media,
    });
    checks.push(
      check(
        "sample-render",
        "样例渲染",
        render.ok,
        render.ok ? `渲染哈希 ${render.artifactHash.slice(0, 12)}` : render.issues.map((item) => item.message).join("；"),
      ),
    );
    issues.push(...render.issues);

    const traceIssues: ValidationIssue[] = [];
    const containers = instance.ast.kind === "feishu_doc" ? instance.ast.sections : instance.ast.slides;
    const nodes = new Map(containers.flatMap(container => container.blocks.map(block => [String(block.id), { block, container }] as const)));
    const tracesBySlot = new Map<string, typeof instance.slotTrace>();
    const claimedBlocks = new Set<string>();
    for (const trace of instance.slotTrace) {
      const traces = tracesBySlot.get(trace.slotId) ?? [];
      traces.push(trace);
      tracesBySlot.set(trace.slotId, traces);
      const slot = pkg.slots.find(slot => slot.id === trace.slotId);
      const path = `instance.slotTrace.${trace.slotId}`;
      if (slot === undefined || traces.length > 1) {
        traceIssues.push(issue("INSTANCE_SLOT_TRACE_INVALID", path, "轨迹槽位不存在或重复"));
        continue;
      }
      if (trace.status !== "placed") continue;
      const node = nodes.get(trace.blockId);
      if (node === undefined || claimedBlocks.has(trace.blockId)) {
        traceIssues.push(issue("INSTANCE_SLOT_NODE_INVALID", path, "轨迹指向缺失或重复认领的节点"));
        continue;
      }
      claimedBlocks.add(trace.blockId);
      const definitionContainers = instance.ast.kind === "feishu_doc" ? pkg.narrative.doc.sections : pkg.narrative.deck.slides;
      const containerIndex = definitionContainers.findIndex(container => container.id === slot.containerId);
      const expectedContainer = containers[containerIndex];
      if (node.container.id !== trace.containerNodeId || node.container.id !== expectedContainer?.id || (instance.ast.kind === "html_deck" && node.block.slotId !== slot.layoutSlotId)) {
        traceIssues.push(issue("INSTANCE_SLOT_CONTAINER_INVALID", path, "轨迹节点不在所声明容器或版式槽位中"));
      }
      traceIssues.push(...validatePlacedSlot(slot, node.block, path));
    }
    for (const slot of requiredSlots) {
      const traces = tracesBySlot.get(slot.id) ?? [];
      if (traces.length !== 1 || traces[0]?.status !== "placed") traceIssues.push(issue("REQUIRED_SLOT_NOT_PLACED", `slots.${slot.id}`, "必填槽位未唯一落位"));
    }
    checks.push(check("required-slot-trace", "必填槽位实际落位", traceIssues.length === 0, traceIssues.length === 0 ? "轨迹指向现存容器与节点且满足类型容量" : traceIssues.map(item => item.message).join("；")));
    issues.push(...traceIssues);

    const sampleResiduals = findResiduals(collectAstText(instance.ast));
    checks.push(
      check(
        "sample-residuals",
        "样例客户数据残留",
        sampleResiduals.length === 0,
        sampleResiduals.length === 0 ? "样例未发现价格或商家专属数据" : "样例含可疑客户数据",
      ),
    );
    issues.push(...sampleResiduals);

    const contrast = computeThemeContrast(pkg.theme);
    const contrastOk = contrast.minimum >= MIN_CONTRAST;
    checks.push(
      check(
        "contrast",
        "主题对比度",
        contrastOk,
        `最小值 ${contrast.minimum.toFixed(2)}，要求 ≥ ${MIN_CONTRAST}`,
      ),
    );
    if (!contrastOk) {
      issues.push(
        issue(
          "CONTRAST_TOO_LOW",
          "theme.palette",
          `主题最小对比度 ${contrast.minimum.toFixed(2)} 低于 ${MIN_CONTRAST}`,
        ),
      );
    }

    const evidenceParsed = ReadyRenderEvidenceSchema.safeParse(options.evidence);
    if (!evidenceParsed.success) {
      checks.push(
        check(
          "render-evidence",
          "Chromium 打印证据",
          false,
          "缺少真实 Chromium 加载与打印证据",
        ),
      );
      issues.push(
        issue(
          "SAMPLE_RENDER_EVIDENCE_REQUIRED",
          "options.evidence",
          "ready 校验需要真实 Chromium 加载、打印和 PDF 证据",
        ),
      );
    } else {
      const evidence = evidenceParsed.data;
      if (evidence.templateHash !== canonicalHash(pkg)) issues.push(issue("RENDER_EVIDENCE_TEMPLATE_HASH_MISMATCH", "evidence.templateHash", "证据未绑定当前整个模板规范"));
      if (evidence.astHash !== canonicalHash(instance.ast)) issues.push(issue("RENDER_EVIDENCE_AST_HASH_MISMATCH", "evidence.astHash", "证据未绑定当前 AST"));

      const evidenceChecks = [
        check(
          "evidence-source",
          "证据来源",
          evidence.source === "chromium" &&
            evidence.rendererVersion === pkg.rendererVersion &&
            evidence.sampleHash === render.artifactHash,
          `source=${evidence.source} renderer=${evidence.rendererVersion}`,
        ),
        check(
          "evidence-load",
          "真实加载",
          evidence.loaded &&
            evidence.missingResources.length === 0 &&
            evidence.externalRequests.length === 0,
          `缺资源 ${evidence.missingResources.length}，外部请求 ${evidence.externalRequests.length}`,
        ),
        check(
          "evidence-overflow",
          "屏幕与打印溢出",
          !evidence.overflow.screen && !evidence.overflow.print,
          `screen=${evidence.overflow.screen} print=${evidence.overflow.print}`,
        ),
        check(
          "evidence-print",
          "打印产物",
          evidence.print.pages > 0 &&
            evidence.print.pdfBytes > 0 &&
            (pkg.manifest.kind === "feishu_doc" ||
              (instance.ast.kind === "html_deck" &&
                evidence.print.pages === instance.ast.slides.length)),
          `pages=${evidence.print.pages} bytes=${evidence.print.pdfBytes}`,
        ),
      ];
      checks.push(...evidenceChecks);
      for (const evidenceCheck of evidenceChecks) {
        if (!evidenceCheck.ok) {
          issues.push(
            issue(
              "RENDER_EVIDENCE_INVALID",
              `evidence.${evidenceCheck.id}`,
              evidenceCheck.detail,
            ),
          );
        }
      }
      if (evidence.sampleHash !== render.artifactHash) {
        issues.push(
          issue(
            "RENDER_EVIDENCE_HASH_MISMATCH",
            "evidence.sampleHash",
            "证据哈希与当前样例 HTML 不一致",
          ),
        );
      }
    }
  }

  const reviewChecks = [...checks];
  const pass = issues.length === 0 && reviewChecks.every((item) => item.ok);
  const review: ReadyReview = {
    decision: pass ? "pass" : "blocked",
    recommendedStatus: pass ? "ready" : null,
    generatedAt: options.now ?? new Date().toISOString(),
    checks: reviewChecks,
    evidenceHash: options.evidence?.sampleHash ?? null,
  };
  return {
    ok: pass,
    mode: options.mode,
    package: pkg,
    checks,
    issues,
    readyReview: review,
  };
}

export function hashReadyReview(review: ReadyReview): string {
  return sha256Hex(JSON.stringify(review));
}
