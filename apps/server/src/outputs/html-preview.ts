import { createHash } from "node:crypto";
import { z } from "zod";
import { unzipFiles, validateZipPath } from "@dmall/renderers";
import { ApiError } from "../errors.js";

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("dcw_offline_html"),
  exportId: z.uuid().optional(),
  revisionId: z.uuid(), contentId: z.uuid(), renditionId: z.uuid(),
  files: z.array(z.object({
    path: z.string(), mime: z.string(), bytes: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })).min(1),
});

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readOfflineHtml(input: {
  bytes: Uint8Array; manifestHash: string; exportId: string;
  contentId: string; renditionId: string; revisionId: string;
}): Map<string, { bytes: Buffer; mime: string }> {
  try {
    const files = unzipFiles(input.bytes);
    const manifestBytes = files["manifest.json"];
    if (manifestBytes === undefined || hash(manifestBytes) !== input.manifestHash) throw new Error("离线清单校验失败");
    const manifest = ManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString("utf8")));
    if ((manifest.exportId !== undefined && manifest.exportId !== input.exportId)
      || manifest.contentId !== input.contentId || manifest.renditionId !== input.renditionId
      || manifest.revisionId !== input.revisionId) throw new Error("离线清单与输出修订不匹配");
    const resources = new Map<string, { bytes: Buffer; mime: string }>();
    for (const item of manifest.files) {
      validateZipPath(item.path);
      const bytes = files[item.path];
      if (resources.has(item.path) || bytes === undefined || bytes.byteLength !== item.bytes || hash(bytes) !== item.sha256) {
        throw new Error(`离线资源校验失败: ${item.path}`);
      }
      resources.set(item.path, { bytes: Buffer.from(bytes), mime: item.mime });
    }
    if (!resources.has("index.html")) throw new Error("离线包缺少实际页面");
    return resources;
  } catch (error) {
    throw new ApiError({ statusCode: 422, code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : "离线包损坏" });
  }
}
