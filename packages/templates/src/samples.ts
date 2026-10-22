import type { ContentKind } from "@dmall/contracts";
import {
  BriefSchema,
  FactRefSchema,
  MaterialRefSchema,
  TemplatePackageSchema,
  type NarrativeId,
  type TemplateInstance,
  type TemplatePackage,
} from "@dmall/contracts";
import { buildBuiltinTemplatePackage, builtinNarratives } from "./catalog.js";
import { instantiateTemplate } from "./instantiate.js";
import { stableUuid } from "./ids.js";

export interface SyntheticSample {
  narrativeId: NarrativeId;
  kind: ContentKind;
  packageValue: TemplatePackage;
  brief: ReturnType<typeof BriefSchema.parse>;
  materials: ReturnType<typeof MaterialRefSchema.parse>[];
  facts: ReturnType<typeof FactRefSchema.parse>[];
  slotBindings: Record<string, unknown>;
  instance: TemplateInstance;
  mediaPaths: Record<string, string>;
}

export interface TemplateValidationSample {
  brief: ReturnType<typeof BriefSchema.parse>;
  materials: ReturnType<typeof MaterialRefSchema.parse>[];
  facts: ReturnType<typeof FactRefSchema.parse>[];
  instance: TemplateInstance;
  mediaPaths: Record<string, string>;
}

function syntheticMaterials(): SyntheticSample["materials"] {
  const sourceVersionIds = [
    stableUuid("sample:source:alpha"),
    stableUuid("sample:source:beta"),
    stableUuid("sample:source:gamma"),
  ];
  return [
    MaterialRefSchema.parse({
      schemaVersion: 1,
      materialId: stableUuid("sample:material:flow"),
      kind: "image",
      assetVersionId: stableUuid("sample:asset:flow"),
      derivativeId: stableUuid("sample:derivative:flow"),
      occurrenceId: stableUuid("sample:occurrence:flow"),
      sourceVersionId: sourceVersionIds[0],
      locator: { kind: "block", blockId: "synthetic-flow" },
      caption: "合成示意 A：流程占位图，非真实材料。",
      alt: "合成示意的流程占位图",
      fit: "cover",
    }),
    MaterialRefSchema.parse({
      schemaVersion: 1,
      materialId: stableUuid("sample:material:evidence"),
      kind: "image",
      assetVersionId: stableUuid("sample:asset:evidence"),
      derivativeId: stableUuid("sample:derivative:evidence"),
      occurrenceId: stableUuid("sample:occurrence:evidence"),
      sourceVersionId: sourceVersionIds[1],
      locator: { kind: "page", page: 2 },
      caption: "合成示意 B：证据占位图，非真实材料。",
      alt: "合成示意的证据占位图",
      fit: "contain",
    }),
    MaterialRefSchema.parse({
      schemaVersion: 1,
      materialId: stableUuid("sample:material:compare"),
      kind: "image",
      assetVersionId: stableUuid("sample:asset:compare"),
      derivativeId: null,
      occurrenceId: stableUuid("sample:occurrence:compare"),
      sourceVersionId: sourceVersionIds[2],
      locator: { kind: "block", blockId: "synthetic-compare" },
      caption: "合成示意 C：对照占位图，非真实材料。",
      alt: "合成示意的对照占位图",
      fit: "cover",
    }),
  ];
}

function syntheticFacts(): SyntheticSample["facts"] {
  const merchantId = stableUuid("sample:merchant");
  return [
    FactRefSchema.parse({
      schemaVersion: 1,
      factVersionId: stableUuid("sample:fact:cycle-time"),
      merchantId,
      statement: "合成示意：示例团队的周均确认时间从 18 分钟缩短到 6 分钟。",
    }),
    FactRefSchema.parse({
      schemaVersion: 1,
      factVersionId: stableUuid("sample:fact:coverage"),
      merchantId,
      statement: "合成示意：示例流程覆盖三个练习步骤，未使用真实商家数据。",
    }),
  ];
}

export function createSyntheticSample(
  narrativeId: NarrativeId,
  kind: ContentKind,
): SyntheticSample {
  const narrative = builtinNarratives.find((item) => item.id === narrativeId);
  if (narrative === undefined) throw new Error(`未知叙事 ${narrativeId}`);
  const packageValue = buildBuiltinTemplatePackage(narrativeId, kind);
  const materials = syntheticMaterials();
  const facts = syntheticFacts();
  const merchantId = stableUuid("sample:merchant");
  const sourceVersionIds = materials.map((item) => item.sourceVersionId);
  const brief = BriefSchema.parse({
    schemaVersion: 1,
    contentId: stableUuid(`sample:content:${kind}:${narrativeId}`),
    goal:
      kind === "feishu_doc"
        ? `合成示意：${narrative.name}文档`
        : `合成示意：${narrative.name}演示`,
    audience: ["内部评审", "模板验收"],
    merchantId,
    targetKind: kind,
    durationMinutes: 10,
    userOutline:
      kind === "feishu_doc"
        ? narrative.doc.sections.slice(0, 5).map((section, index) => ({
            id: stableUuid(`sample:outline:${narrativeId}:${index}`),
            title: section.title,
          }))
        : [],
    mustKeepOutline: kind === "feishu_doc",
    tone: "简洁、具体",
    sourceScope: {
      sourceVersionIds,
      excludeIds: [],
    },
    unresolvedQuestions: [],
  });
  const slotBindings: Record<string, unknown> =
    kind === "feishu_doc"
      ? {
          [`${narrative.doc.sections[0]?.id ?? "problem"}-body`]: {
            kind: "fact",
            factVersionId: facts[0]?.factVersionId,
          },
          [`${narrative.doc.sections[0]?.id ?? "problem"}-evidence`]: {
            kind: "material",
            materialId: materials[0]?.materialId,
          },
          [`${narrative.doc.sections[1]?.id ?? "positioning"}-evidence`]: {
            kind: "material",
            materialId: materials[1]?.materialId,
          },
          [`${narrative.doc.sections[2]?.id ?? "scenario"}-evidence`]: {
            kind: "material",
            materialId: materials[2]?.materialId,
          },
        }
      : {
          "cover-subtitle": {
            kind: "text",
            text: "合成示意：展示受控版式、槽位和证据绑定。",
          },
          "detail-body": {
            kind: "fact",
            factVersionId: facts[0]?.factVersionId,
          },
          "detail-media": {
            kind: "material",
            materialId: materials[0]?.materialId,
          },
          "compare-left": {
            kind: "text",
            text: "现状：用显式事实描述已经确认的问题。",
          },
          "compare-right": {
            kind: "text",
            text: "方案：只承诺证据支持的处理方式。",
          },
          "metric-metric": {
            kind: "fact",
            factVersionId: facts[1]?.factVersionId,
          },
          "metric-evidence": {
            kind: "material",
            materialId: materials[1]?.materialId,
          },
          "metric-explanation": {
            kind: "text",
            text: "指标与期间必须来自同一 factVersion，模板不保存客户值。",
          },
          "steps-steps": {
            kind: "list",
            items: ["确认事实与来源", "选择适用素材", "按样板验收"],
          },
          "evidence-data": {
            kind: "table",
            columns: ["维度", "合成示意"],
            rows: [
              ["目标", "验证版式与槽位"],
              ["证据", "显式 factVersion"],
              ["媒体", "本地生成的示意资源"],
            ],
          },
          "closing-next": {
            kind: "list",
            items: ["补充真实来源", "完成集成接线", "执行 T07 导出"],
          },
        };
  const result = instantiateTemplate({
    templatePackage: packageValue,
    brief,
    targetKind: kind,
    materials,
    facts,
    slotBindings,
  });
  if (!result.ok) {
    throw new Error(
      `合成样例实例化失败: ${result.issues.map((item) => item.message).join("；")}`,
    );
  }
  return {
    narrativeId,
    kind,
    packageValue,
    brief,
    materials,
    facts,
    slotBindings,
    instance: result.instance,
    mediaPaths: {
      [`derivative:${materials[0]?.kind === "image" ? materials[0].derivativeId : ""}`]: "assets/synthetic-flow.svg",
      [`derivative:${materials[1]?.kind === "image" ? materials[1].derivativeId : ""}`]: "assets/synthetic-evidence.svg",
      [`asset_version:${materials[2]?.assetVersionId ?? ""}`]: "assets/synthetic-compare.svg",
    },
  };
}

export function createTemplateValidationSample(
  templatePackage: TemplatePackage,
): TemplateValidationSample {
  const parsedPackage = TemplatePackageSchema.parse(templatePackage);
  const merchantId = stableUuid("validation:merchant");
  const imageSourceId = stableUuid("validation:source:image");
  const videoSourceId = stableUuid("validation:source:video");
  const image = MaterialRefSchema.parse({
    schemaVersion: 1,
    materialId: stableUuid("validation:material:image"),
    kind: "image",
    assetVersionId: stableUuid("validation:asset:image"),
    derivativeId: stableUuid("validation:derivative:image"),
    occurrenceId: stableUuid("validation:occurrence:image"),
    sourceVersionId: imageSourceId,
    locator: { kind: "block", blockId: "validation-image" },
    caption: "模板验证示意图片",
    alt: "模板验证示意图片",
    fit: "contain",
  });
  const video = MaterialRefSchema.parse({
    schemaVersion: 1,
    materialId: stableUuid("validation:material:video"),
    kind: "video",
    assetVersionId: stableUuid("validation:asset:video"),
    segmentId: null,
    posterDerivativeId: stableUuid("validation:derivative:poster"),
    sourceVersionId: videoSourceId,
    locator: { kind: "block", blockId: "validation-video" },
    caption: "模板验证示意视频静帧",
  });
  if (image.kind !== "image" || video.kind !== "video") {
    throw new Error("验证样例素材类型不匹配");
  }
  const fact = FactRefSchema.parse({
    schemaVersion: 1,
    factVersionId: stableUuid("validation:fact"),
    merchantId,
    statement: "模板验证样例事实，仅用于本机渲染检查。",
  });
  const brief = BriefSchema.parse({
    schemaVersion: 1,
    contentId: stableUuid(`validation:content:${parsedPackage.manifest.templateVersionId}`),
    goal: "模板验证样例",
    audience: ["模板验收"],
    merchantId,
    targetKind: parsedPackage.manifest.kind,
    durationMinutes: 10,
    userOutline: [],
    mustKeepOutline: false,
    tone: "简洁、具体",
    sourceScope: {
      sourceVersionIds: [imageSourceId, videoSourceId],
      excludeIds: [],
    },
    unresolvedQuestions: [],
  });
  const materials = [image, video];
  const result = instantiateTemplate({
    templatePackage: parsedPackage,
    brief,
    targetKind: parsedPackage.manifest.kind,
    materials,
    facts: [fact],
  });
  if (!result.ok) {
    throw new Error(
      `模板验证样例实例化失败: ${result.issues.map((item) => item.message).join("；")}`,
    );
  }
  return {
    brief,
    materials,
    facts: [fact],
    instance: result.instance,
    mediaPaths: {
      [`derivative:${image.derivativeId ?? ""}`]: "assets/validation-image.svg",
      [`derivative:${video.posterDerivativeId}`]: "assets/validation-poster.svg",
    },
  };
}
