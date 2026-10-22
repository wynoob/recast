import { z } from "zod";
import { UuidSchema } from "./ids.js";

export const AssetMapSelectionSchema = z
  .strictObject({
    format: z.literal("markdown-asset-table/v1"),
    sourceScanItemIds: z.array(UuidSchema).min(1).max(3),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.sourceScanItemIds).size !== value.sourceScanItemIds.length) {
      ctx.addIssue({ code: "custom", message: "映射来源项不能重复" });
    }
  });
export type AssetMapSelection = z.infer<typeof AssetMapSelectionSchema>;

export const AssetMapWarningSchema = z.strictObject({
  code: z.enum([
    "EXTERNAL_PATH",
    "ABSOLUTE_PATH",
    "OUTSIDE_ROOT",
    "PATH_NOT_SELECTED",
    "PATH_NOT_MEDIA",
    "EMPTY_FILE",
    "EMPTY_USE",
    "INVALID_TITLE",
    "ROW_TOO_LARGE",
    "UNSUPPORTED_COLUMNS",
    "MAPPING_EMPTY",
    "MAPPING_FORMAT_NOT_FOUND",
  ]),
  tableIndex: z.int().nonnegative().nullable(),
  rowIndex: z.int().nonnegative().nullable(),
  fileCell: z.string().nullable(),
  detail: z.string(),
});
export type AssetMapWarning = z.infer<typeof AssetMapWarningSchema>;

export const AssetMapCommitResultSchema = z.strictObject({
  status: z.enum(["applied", "failed"]),
  parserVersion: z.literal("dcw-asset-map/1"),
  errorCode: z
    .enum([
      "MAPPING_NOT_UTF8",
      "MAPPING_ROW_LIMIT_EXCEEDED",
      "MAPPING_CELL_TOO_LARGE",
      "MAPPING_WARNING_LIMIT_EXCEEDED",
      "MAPPING_FORMAT_NOT_FOUND",
      "MAPPING_READ_FAILED",
    ])
    .nullable(),
  sourceVersionId: UuidSchema,
  entryCount: z.int().nonnegative(),
  warningCount: z.int().nonnegative(),
  warnings: z.array(AssetMapWarningSchema).max(5000),
});
export type AssetMapCommitResult = z.infer<typeof AssetMapCommitResultSchema>;
