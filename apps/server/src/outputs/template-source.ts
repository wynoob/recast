import type Database from "better-sqlite3";
import { z } from "zod";
import {
  TemplatePackageSchema,
  type ContentKind,
  type TemplatePackage,
} from "@dmall/contracts";
import { buildBuiltinTemplatePackage } from "@dmall/templates";
import { MANUAL_OUTPUT_TEMPLATE_ID, manualOutputTemplate } from "@dmall/renderers";
import { ApiError } from "../errors.js";

const TemplateRowSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["feishu_doc", "html_deck"]),
  status: z.enum(["draft", "ready", "archived"]),
  package_json: z.string().nullable(),
});

export interface OutputTemplateSource {
  package: TemplatePackage;
  templateVersionId: string | null;
  source: "fixed" | "builtin_fallback";
  warning: string | null;
}

export function loadOutputTemplate(
  db: Database.Database,
  templateVersionId: string | null,
  kind: ContentKind,
): OutputTemplateSource {
  if (templateVersionId === null) {
    const narrative = kind === "feishu_doc" ? "product-intro" : "executive-progress";
    const builtin = buildBuiltinTemplatePackage(narrative, kind);
    return {
      package: kind === "html_deck" ? manualOutputTemplate(builtin) : builtin,
      templateVersionId: null,
      source: "builtin_fallback",
      warning: "该修订没有固定模板版本，使用内置基础模板快照输出；建议在编辑器中先固定模板。",
    };
  }
  const row = db.prepare(
    "SELECT id, kind, status, package_json FROM template_versions WHERE id = ?",
  ).get(templateVersionId);
  if (row === undefined) {
    throw new ApiError({
      statusCode: 422,
      code: "UNKNOWN_REFERENCE",
      message: "修订固定的模板版本不存在，不能输出",
    });
  }
  const parsed = TemplateRowSchema.parse(row);
  if (parsed.kind !== kind) {
    throw new ApiError({
      statusCode: 422,
      code: "TEMPLATE_INVALID",
      message: "修订格式与固定模板类型不一致",
    });
  }
  if (parsed.package_json === null) {
    throw new ApiError({
      statusCode: 422,
      code: "TEMPLATE_INVALID",
      message: "模板版本缺少完整包快照，不能复现输出",
    });
  }
  let packageValue: TemplatePackage;
  try {
    packageValue = TemplatePackageSchema.parse(JSON.parse(parsed.package_json) as unknown);
  } catch {
    throw new ApiError({
      statusCode: 422,
      code: "TEMPLATE_INVALID",
      message: "模板包快照无法通过结构校验",
    });
  }
  if (packageValue.manifest.id === MANUAL_OUTPUT_TEMPLATE_ID) {
    throw new ApiError({ statusCode: 422, code: "TEMPLATE_INVALID", message: "自由创作输出布局不能作为固定模板使用" });
  }
  return {
    package: packageValue,
    templateVersionId: parsed.id,
    source: "fixed",
    warning: null,
  };
}
