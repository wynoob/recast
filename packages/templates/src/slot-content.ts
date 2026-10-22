import { NodeIdSchema, ProvenanceSchema, type Block, type Inlines, type Provenance } from "@dmall/contracts";
import type {
  Brief,
  FactRef,
  MaterialRef,
  SlotBinding,
  SlotTrace,
  SourceVersionId,
  TemplateSlot,
  ValidationIssue,
} from "@dmall/contracts";
import { stableUuid } from "./ids.js";

export interface SlotContext {
  brief: Brief;
  materials: MaterialRef[];
  facts: FactRef[];
  bindings: Record<string, SlotBinding>;
  slotsByContainer: Map<string, TemplateSlot[]>;
}

export interface ContainerSlots {
  blocks: Block[];
  trace: SlotTrace[];
  issues: ValidationIssue[];
  warnings: string[];
}

export function buildContainerSlots(context: SlotContext, containerId: string, containerNodeId: string, kind: "doc" | "deck", path: string): ContainerSlots {
  const result: ContainerSlots = { blocks: [], trace: [], issues: [], warnings: [] };
  for (const slot of context.slotsByContainer.get(containerId) ?? []) {
    const slotPath = `${path}.slots.${slot.id}`;
    const resolved = resolveSlot(slot, context.brief, context.materials, context.facts, context.bindings[slot.id], slotPath);
    result.issues.push(...resolved.issues);
    if (resolved.value === null) continue;
    const built = buildSlot(slot, resolved.value, stableUuid(`${context.brief.contentId}:${kind}:${slot.containerId}:${slot.id}`), kind === "deck" ? slot.layoutSlotId ?? null : null, containerNodeId, slotPath);
    result.issues.push(...built.issues);
    result.warnings.push(...built.warnings);
    if (built.block !== null) result.blocks.push(built.block);
    if (built.trace !== null) result.trace.push(built.trace);
  }
  return result;
}

interface ResolvedText {
  kind: "text";
  text: string;
  provenance: Provenance[];
  source: SlotTrace["source"];
  detail: string;
}

interface ResolvedList {
  kind: "list";
  items: string[];
  provenance: Provenance[];
  source: SlotTrace["source"];
  detail: string;
}

interface ResolvedTable {
  kind: "table";
  columns: string[];
  rows: string[][];
  provenance: Provenance[];
  source: SlotTrace["source"];
  detail: string;
}

interface ResolvedMaterial {
  kind: "material";
  material: MaterialRef;
  provenance: Provenance[];
  source: "material" | "binding";
  detail: string;
}

interface ResolvedEmpty {
  kind: "empty";
  detail: string;
  source: "material" | "fact";
}

type ResolvedSlot =
  | ResolvedText
  | ResolvedList
  | ResolvedTable
  | ResolvedMaterial
  | ResolvedEmpty;

interface SlotResolution {
  value: ResolvedSlot | null;
  issues: ValidationIssue[];
}

function issue(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, path, message };
}

function isInSourceScope(brief: Brief, sourceVersionId: SourceVersionId): boolean {
  return (
    brief.sourceScope.sourceVersionIds.includes(sourceVersionId) &&
    !brief.sourceScope.excludeIds.includes(sourceVersionId)
  );
}

function materialMatchesSlot(
  material: MaterialRef,
  slot: TemplateSlot,
): boolean {
  if (slot.source.kind !== "material") return false;
  return material.kind === slot.source.mediaKind;
}

function applicableMaterials(
  slot: TemplateSlot,
  brief: Brief,
  materials: MaterialRef[],
): MaterialRef[] {
  return materials.filter(
    (material) =>
      materialMatchesSlot(material, slot) &&
      isInSourceScope(brief, material.sourceVersionId),
  );
}

function applicableFacts(brief: Brief, facts: FactRef[]): FactRef[] {
  return facts.filter((fact) => fact.merchantId === brief.merchantId);
}

function materialProvenance(material: MaterialRef): Provenance[] {
  return [
    ProvenanceSchema.parse({
      kind: "source",
      sourceVersionId: material.sourceVersionId,
      locator: material.locator,
    }),
  ];
}

function factProvenance(fact: FactRef): Provenance[] {
  return [
    ProvenanceSchema.parse({
      kind: "fact",
      factVersionId: fact.factVersionId,
    }),
  ];
}

function resolveBindingText(
  binding: SlotBinding,
  slot: TemplateSlot,
  path: string,
): SlotResolution {
  if (binding.kind === "text") {
    if (
      slot.blockType !== "paragraph" &&
      slot.blockType !== "callout" &&
      slot.blockType !== "divider"
    ) {
      return {
        value: null,
        issues: [
          issue(
            "SLOT_BINDING_KIND_MISMATCH",
            path,
            `${slot.blockType} 槽位不能使用文本绑定`,
          ),
        ],
      };
    }
    return {
      value: {
        kind: "text",
        text: binding.text,
        provenance: [],
        source: "binding",
        detail: "显式文本绑定",
      },
      issues: [],
    };
  }
  if (binding.kind === "list") {
    if (slot.blockType !== "list") {
      return {
        value: null,
        issues: [
          issue(
            "SLOT_BINDING_KIND_MISMATCH",
            path,
            `${slot.blockType} 槽位不能使用列表绑定`,
          ),
        ],
      };
    }
    return {
      value: {
        kind: "list",
        items: binding.items,
        provenance: [],
        source: "binding",
        detail: "显式列表绑定",
      },
      issues: [],
    };
  }
  if (binding.kind === "table") {
    if (slot.blockType !== "table") {
      return {
        value: null,
        issues: [
          issue(
            "SLOT_BINDING_KIND_MISMATCH",
            path,
            `${slot.blockType} 槽位不能使用表格绑定`,
          ),
        ],
      };
    }
    return {
      value: {
        kind: "table",
        columns: binding.columns,
        rows: binding.rows,
        provenance: [],
        source: "binding",
        detail: "显式表格绑定",
      },
      issues: [],
    };
  }
  return {
    value: null,
    issues: [
      issue(
        "SLOT_BINDING_KIND_MISMATCH",
        path,
        "素材或事实绑定必须通过对应引用解析",
      ),
    ],
  };
}

function resolveMaterialBinding(
  binding: SlotBinding,
  slot: TemplateSlot,
  brief: Brief,
  materials: MaterialRef[],
  path: string,
): SlotResolution {
  if (binding.kind !== "material") {
    return {
      value: null,
      issues: [
        issue(
          "SLOT_BINDING_KIND_MISMATCH",
          path,
          "媒体槽位需要素材绑定",
        ),
      ],
    };
  }
  if (slot.source.kind !== "material") {
    return {
      value: null,
      issues: [
        issue(
          "SLOT_SOURCE_MISMATCH",
          path,
          "槽位未声明素材来源",
        ),
      ],
    };
  }
  const material = materials.find((item) => item.materialId === binding.materialId);
  if (material === undefined) {
    return {
      value: null,
      issues: [
        issue(
          "UNKNOWN_MATERIAL_REF",
          path,
          `素材引用不存在: ${binding.materialId}`,
        ),
      ],
    };
  }
  if (material.kind !== slot.source.mediaKind) {
    return {
      value: null,
      issues: [
        issue(
          "MATERIAL_KIND_MISMATCH",
          path,
          `槽位需要 ${slot.source.mediaKind}，实际为 ${material.kind}`,
        ),
      ],
    };
  }
  if (!isInSourceScope(brief, material.sourceVersionId)) {
    return {
      value: null,
      issues: [
        issue(
          "SOURCE_OUT_OF_SCOPE",
          path,
          `素材来源不在 sourceScope 内: ${material.sourceVersionId}`,
        ),
      ],
    };
  }
  return {
    value: {
      kind: "material",
      material,
      provenance: materialProvenance(material),
      source: "binding",
      detail: `显式素材绑定 ${material.materialId}`,
    },
    issues: [],
  };
}

function resolveFactBinding(
  binding: SlotBinding,
  slot: TemplateSlot,
  brief: Brief,
  facts: FactRef[],
  path: string,
): SlotResolution {
  if (binding.kind !== "fact") {
    return {
      value: null,
      issues: [
        issue(
          "SLOT_BINDING_KIND_MISMATCH",
          path,
          "事实绑定类型不匹配",
        ),
      ],
    };
  }
  const fact = facts.find((item) => item.factVersionId === binding.factVersionId);
  if (fact === undefined) {
    return {
      value: null,
      issues: [
        issue(
          "UNKNOWN_FACT_REF",
          path,
          `事实引用不存在: ${binding.factVersionId}`,
        ),
      ],
    };
  }
  if (fact.merchantId !== brief.merchantId) {
    return {
      value: null,
      issues: [
        issue(
          "FACT_MERCHANT_MISMATCH",
          path,
          "事实商家与 brief 商家不一致",
        ),
      ],
    };
  }
  return resolveFactValue(fact, slot, "binding", `显式事实绑定 ${fact.factVersionId}`, path);
}

function resolveFactValue(
  fact: FactRef,
  slot: TemplateSlot,
  source: "fact" | "binding",
  detail: string,
  path: string,
): SlotResolution {
  if (!["paragraph", "callout", "list", "table"].includes(slot.blockType)) {
    return {
      value: null,
      issues: [
        issue(
          "SLOT_BINDING_KIND_MISMATCH",
          path,
          `${slot.blockType} 槽位不能使用事实绑定`,
        ),
      ],
    };
  }
  const provenance = factProvenance(fact);
  if (slot.blockType === "list") {
    return {
      value: {
        kind: "list",
        items: [fact.statement],
        provenance,
        source,
        detail,
      },
      issues: [],
    };
  }
  if (slot.blockType === "table") {
    return {
      value: {
        kind: "table",
        columns: ["事实"],
        rows: [[fact.statement]],
        provenance,
        source,
        detail,
      },
      issues: [],
    };
  }
  return {
    value: {
      kind: "text",
      text: fact.statement,
      provenance,
      source,
      detail,
    },
    issues: [],
  };
}

function resolveBoundSlot(
  binding: SlotBinding,
  slot: TemplateSlot,
  brief: Brief,
  materials: MaterialRef[],
  facts: FactRef[],
  path: string,
): SlotResolution {
  if (binding.kind === "material") {
    return resolveMaterialBinding(binding, slot, brief, materials, path);
  }
  if (binding.kind === "fact") {
    return resolveFactBinding(binding, slot, brief, facts, path);
  }
  return resolveBindingText(binding, slot, path);
}

function briefText(
  brief: Brief,
  field: "title" | "goal" | "tone" | "audience" | "durationMinutes",
): string | null {
  switch (field) {
    case "title":
    case "goal":
      return brief.goal.trim() === "" ? null : brief.goal;
    case "tone":
      return brief.tone.trim() === "" ? null : brief.tone;
    case "audience":
      return brief.audience.join("、");
    case "durationMinutes":
      return brief.durationMinutes === null ? null : `${brief.durationMinutes} 分钟`;
  }
}

function resolveSourceSlot(
  slot: TemplateSlot,
  brief: Brief,
  materials: MaterialRef[],
  facts: FactRef[],
  path: string,
): SlotResolution {
  switch (slot.source.kind) {
    case "default": {
      const value = slot.source.value;
      if (value.kind === "text") {
        return {
          value: {
            kind: "text",
            text: value.text,
            provenance: [],
            source: "default",
            detail: "模板默认占位",
          },
          issues: [],
        };
      }
      if (value.kind === "list") {
        return {
          value: {
            kind: "list",
            items: value.items,
            provenance: [],
            source: "default",
            detail: "模板默认列表",
          },
          issues: [],
        };
      }
      return {
        value: {
          kind: "table",
          columns: value.columns,
          rows: value.rows,
          provenance: [],
          source: "default",
          detail: "模板默认表格",
        },
        issues: [],
      };
    }
    case "brief": {
      if (slot.source.field === "outline") {
        if (slot.blockType === "list") {
          return {
            value: {
              kind: "list",
              items: brief.userOutline.map((item) => item.title),
              provenance: [],
              source: "brief",
              detail: "brief.userOutline",
            },
            issues: [],
          };
        }
        return {
          value: {
            kind: "text",
            text: brief.userOutline.map((item) => item.title).join("；"),
            provenance: [],
            source: "brief",
            detail: "brief.userOutline",
          },
          issues: [],
        };
      }
      const text = briefText(brief, slot.source.field);
      if (text === null) {
        return {
          value: null,
          issues: [
            issue(
              slot.source.field === "durationMinutes"
                ? "DURATION_REQUIRED"
                : "BRIEF_INPUT_REQUIRED",
              path,
              slot.source.field === "durationMinutes"
                ? "模板需要时长，当前 brief.durationMinutes 为 null"
                : `模板需要 brief.${slot.source.field}，当前值为空`,
            ),
          ],
        };
      }
      return {
        value: {
          kind: "text",
          text,
          provenance: [],
          source: "brief",
          detail: `brief.${slot.source.field}`,
        },
        issues: [],
      };
    }
    case "material": {
      const allowed = applicableMaterials(slot, brief, materials);
      if (allowed.length === 0) {
        return {
          value: slot.required
            ? null
            : {
                kind: "empty",
                detail: "可选媒体未提供，已省略",
                source: "material",
              },
          issues: slot.required
            ? [
                issue(
                  "REQUIRED_MATERIAL_MISSING",
                  path,
                  `必填媒体槽位 ${slot.id} 没有可用素材`,
                ),
              ]
            : [],
        };
      }
      if (allowed.length > 1) {
        if (!slot.required) {
          return {
            value: {
              kind: "empty",
              detail: "可选媒体有多个候选，未自动选择，已省略",
              source: "material",
            },
            issues: [],
          };
        }
        return {
          value: null,
          issues: [
            issue(
              "AMBIGUOUS_SLOT_SOURCE",
              path,
              `媒体槽位 ${slot.id} 有多个候选，需要显式绑定`,
            ),
          ],
        };
      }
      const material = allowed[0];
      if (material === undefined) {
        return {
          value: null,
          issues: [
            issue("INTERNAL_SLOT_ERROR", path, "媒体候选解析失败"),
          ],
        };
      }
      return {
        value: {
          kind: "material",
          material,
          provenance: materialProvenance(material),
          source: "material",
          detail: `唯一可用素材 ${material.materialId}`,
        },
        issues: [],
      };
    }
    case "fact": {
      const allowed = applicableFacts(brief, facts);
      if (allowed.length === 0) {
        return {
          value: slot.required
            ? null
            : {
                kind: "empty",
                detail: "可选事实未提供，已省略",
                source: "fact",
              },
          issues: slot.required
            ? [
                issue(
                  "REQUIRED_FACT_MISSING",
                  path,
                  `必填事实槽位 ${slot.id} 没有可用事实`,
                ),
              ]
            : [],
        };
      }
      if (allowed.length > 1) {
        if (!slot.required) {
          return {
            value: {
              kind: "empty",
              detail: "可选事实有多个候选，未自动选择，已省略",
              source: "fact",
            },
            issues: [],
          };
        }
        return {
          value: null,
          issues: [
            issue(
              "AMBIGUOUS_SLOT_SOURCE",
              path,
              `事实槽位 ${slot.id} 有多个候选，需要显式绑定`,
            ),
          ],
        };
      }
      const fact = allowed[0];
      if (fact === undefined) {
        return {
          value: null,
          issues: [
            issue("INTERNAL_SLOT_ERROR", path, "事实候选解析失败"),
          ],
        };
      }
      return resolveFactValue(fact, slot, "fact", `唯一可用事实 ${fact.factVersionId}`, path);
    }
  }
}

function resolveSlot(
  slot: TemplateSlot,
  brief: Brief,
  materials: MaterialRef[],
  facts: FactRef[],
  binding: SlotBinding | undefined,
  path: string,
): SlotResolution {
  if (binding !== undefined) {
    return resolveBoundSlot(binding, slot, brief, materials, facts, path);
  }
  return resolveSourceSlot(slot, brief, materials, facts, path);
}

function validateTextCapacity(
  slot: TemplateSlot,
  text: string,
  path: string,
): ValidationIssue[] {
  const max = slot.capacity.maxCharacters;
  return max !== undefined && text.length > max
    ? [
        issue(
          "SLOT_CAPACITY_EXCEEDED",
          path,
          `槽位 ${slot.id} 文本 ${text.length} 字，超过 ${max} 字`,
        ),
      ]
    : [];
}

function validateListCapacity(
  slot: TemplateSlot,
  items: string[],
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxItems = slot.capacity.maxItems;
  if (maxItems !== undefined && items.length > maxItems) {
    issues.push(
      issue(
        "SLOT_CAPACITY_EXCEEDED",
        path,
        `槽位 ${slot.id} 有 ${items.length} 条，超过 ${maxItems} 条`,
      ),
    );
  }
  const maxCharacters = slot.capacity.maxCharacters;
  if (maxCharacters !== undefined) {
    for (const [index, item] of items.entries()) {
      if (item.length > maxCharacters) {
        issues.push(
          issue(
            "SLOT_CAPACITY_EXCEEDED",
            `${path}[${index}]`,
            `槽位 ${slot.id} 第 ${index + 1} 条超过 ${maxCharacters} 字`,
          ),
        );
      }
    }
  }
  return issues;
}

function validateTableCapacity(
  slot: TemplateSlot,
  table: { columns: string[]; rows: string[][] },
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxRows = slot.capacity.maxRows;
  if (maxRows !== undefined && table.rows.length > maxRows) {
    issues.push(
      issue(
        "SLOT_CAPACITY_EXCEEDED",
        path,
        `槽位 ${slot.id} 表格 ${table.rows.length} 行，超过 ${maxRows} 行`,
      ),
    );
  }
  for (const [index, row] of table.rows.entries()) {
    if (row.length !== table.columns.length) {
      issues.push(
        issue(
          "TABLE_ROW_LENGTH",
          `${path}.rows[${index}]`,
          "表格单元格数与列数不一致",
        ),
      );
    }
  }
  const maxCharacters = slot.capacity.maxCharacters;
  if (maxCharacters !== undefined) {
    const cells = [...table.columns, ...table.rows.flat()];
    for (const [index, cell] of cells.entries()) {
      if (cell.length > maxCharacters) {
        issues.push(
          issue(
            "SLOT_CAPACITY_EXCEEDED",
            `${path}.cells[${index}]`,
            `槽位 ${slot.id} 单元格超过 ${maxCharacters} 字`,
          ),
        );
      }
    }
  }
  return issues;
}

function textInlines(text: string): Inlines {
  return [{ text, marks: [] }];
}

function blockForSlot(
  slot: TemplateSlot,
  value: ResolvedSlot,
  blockId: string,
  slotId: string | null,
): Block | null {
  const base: Pick<Block, "id" | "provenance" | "locks" | "slotId"> = {
    id: NodeIdSchema.parse(blockId),
    provenance: value.kind === "empty" ? [] : value.provenance,
    locks: [],
    ...(slotId === null ? {} : { slotId }),
  };
  switch (slot.blockType) {
    case "paragraph":
      return value.kind === "text"
        ? { ...base, type: "paragraph", inlines: textInlines(value.text) }
        : null;
    case "callout":
      return value.kind === "text"
        ? { ...base, type: "callout", inlines: textInlines(value.text) }
        : null;
    case "divider":
      return { ...base, type: "divider" };
    case "list":
      return value.kind === "list"
        ? {
            ...base,
            type: "list",
            ordered: false,
            items: value.items.map((item) => textInlines(item)),
          }
        : null;
    case "table":
      return value.kind === "table"
        ? {
            ...base,
            type: "table",
            columns: value.columns,
            rows: value.rows.map((row) => row.map((cell) => textInlines(cell))),
          }
        : null;
    case "image":
      return value.kind === "material" && value.material.kind === "image"
        ? {
            ...base,
            type: "image",
            assetVersionId: value.material.assetVersionId,
            derivativeId: value.material.derivativeId,
            occurrenceId: value.material.occurrenceId,
            caption: value.material.caption,
            alt: value.material.alt,
            fit: value.material.fit,
          }
        : null;
    case "video":
      return value.kind === "material" && value.material.kind === "video"
        ? {
            ...base,
            type: "video",
            assetVersionId: value.material.assetVersionId,
            segmentId: value.material.segmentId,
            posterDerivativeId: value.material.posterDerivativeId,
            caption: value.material.caption,
          }
        : null;
  }
}

interface SlotBuildResult {
  block: Block | null;
  trace: SlotTrace | null;
  issues: ValidationIssue[];
  warnings: string[];
}

function buildSlot(
  slot: TemplateSlot,
  value: ResolvedSlot,
  blockId: string,
  slotId: string | null,
  containerNodeId: string,
  path: string,
): SlotBuildResult {
  if (value.kind === "empty") {
    return {
      block: null,
      trace: {
        slotId: slot.id,
        status: "omitted",
        source: value.source,
        detail: value.detail,
      },
      issues: [],
      warnings: [`槽位 ${slot.id} 已省略：${value.detail}`],
    };
  }
  const capacityIssues =
    value.kind === "text"
      ? validateTextCapacity(slot, value.text, path)
      : value.kind === "list"
        ? validateListCapacity(slot, value.items, path)
        : value.kind === "table"
          ? validateTableCapacity(slot, value, path)
          : [];
  if (capacityIssues.length > 0) {
    return { block: null, trace: null, issues: capacityIssues, warnings: [] };
  }
  const block = blockForSlot(slot, value, blockId, slotId);
  if (block === null) {
    return {
      block: null,
      trace: null,
      issues: [
        issue(
          "SLOT_VALUE_INCOMPATIBLE",
          path,
          `槽位 ${slot.id} 的 ${value.kind} 内容不能生成 ${slot.blockType} 块`,
        ),
      ],
      warnings: [],
    };
  }
  return {
    block,
    trace: {
      slotId: slot.id,
      status: "placed",
      source: value.source,
      blockId,
      containerNodeId,
      detail: value.detail,
    },
    issues: [],
    warnings: [],
  };
}


export function validatePlacedSlot(slot: TemplateSlot, block: Block, path: string): ValidationIssue[] {
  if (slot.blockType !== block.type) return [issue("INSTANCE_SLOT_TYPE_MISMATCH", path, `槽位 ${slot.id} 需要 ${slot.blockType}，实际 ${block.type}`)];
  const text = (inlines: Inlines) => inlines.map(inline => inline.text).join("");
  let issues: ValidationIssue[];
  switch (block.type) {
    case "paragraph":
    case "callout": issues = validateTextCapacity(slot, text(block.inlines), path); break;
    case "list": issues = validateListCapacity(slot, block.items.map(text), path); break;
    case "table": issues = validateTableCapacity(slot, { columns: block.columns, rows: block.rows.map(row => row.map(text)) }, path); break;
    default: issues = [];
  }
  return issues.map(item => ({ ...item, code: "INSTANCE_SLOT_CAPACITY_INVALID" }));
}
