import type {
  AssetMapSummary,
  AssetAvailability,
  ImportItemState,
  JobState,
  MediaProbe,
  ScanCounts,
} from "@dmall/contracts";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDurationMs(durationMs: number | null): string {
  if (durationMs === null) return "时长未知";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatDimensions(width: number | null, height: number | null): string {
  return width === null || height === null ? "尺寸未知" : `${width} × ${height}`;
}

export function mediaKindLabel(kind: "image" | "gif" | "video"): string {
  if (kind === "video") return "视频";
  if (kind === "gif") return "GIF";
  return "图片";
}

export function scanKindLabel(
  kind: "image" | "gif" | "video" | "markdown" | "pdf" | "pptx" | "html" | "html_zip" | "unsupported",
): string {
  if (kind === "markdown" || kind === "pdf" || kind === "pptx" || kind === "html" || kind === "html_zip") {
    return kind === "markdown" ? "Markdown" : kind === "pdf" ? "PDF" : kind === "pptx" ? "PPTX" : kind === "html" ? "静态 HTML" : "HTML ZIP";
  }
  if (kind === "unsupported") return "不支持";
  return mediaKindLabel(kind);
}

export function availabilityLabel(value: AssetAvailability): string {
  if (value === "available") return "原件与预览可用";
  if (value === "missing") return "缺少文件或预览";
  return "格式不支持";
}

export function jobStateLabel(state: JobState): string {
  switch (state) {
    case "queued": return "等待开始";
    case "running": return "进行中";
    case "waiting_input": return "等待确认";
    case "succeeded": return "已完成";
    case "partial": return "部分完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
  }
}

export function jobStateTone(state: JobState): "good" | "warn" | "bad" | "muted" {
  if (state === "succeeded") return "good";
  if (state === "partial" || state === "waiting_input") return "warn";
  if (state === "failed") return "bad";
  return "muted";
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case "queued": return "等待开始";
    case "scanning": return "扫描文件";
    case "importing": return "导入素材";
    case "recovered": return "已恢复";
    case "retry": return "准备重试";
    case "done": return "已收尾";
    default: return "处理中";
  }
}

export function importItemStateLabel(state: ImportItemState): string {
  switch (state) {
    case "pending": return "等待";
    case "copying": return "复制原件";
    case "probing": return "核对媒体";
    case "previewing": return "生成预览";
    case "committed": return "已完成";
    case "failed": return "失败";
    case "skipped": return "已跳过";
  }
}

export function scanCountsSummary(counts: ScanCounts): string {
  const media = counts.mp4 + counts.gif + counts.image;
  const documents = counts.markdown + counts.pdf + counts.pptx + counts.html + counts.htmlZip;
  return `${media} 媒体 · ${documents} 文档`;
}

export function scanExclusionLabel(code: string): string {
  switch (code) {
    case "EXCLUDED_DIRECTORY": return "缓存、构建或渲染目录";
    case "EXCLUDED_FILE": return "系统文件、凭证或临时文件";
    case "SYMLINK_OUTSIDE_ROOT": return "指向目录外的链接";
    case "SYMLINK_NOT_FOLLOWED": return "链接未跟随";
    case "UNSUPPORTED_FILE_TYPE": return "不在本阶段支持范围";
    case "SINGLE_FILE_LIMIT": return "单文件超过 2 GB";
    case "PATH_NOT_ALLOWED": return "路径不允许读取";
    case "SOURCE_UNREADABLE": return "文件不可读";
    default: return "已排除";
  }
}

export function mediaStatusLabel(status: "discovered" | "available" | "missing" | "unsupported"): string {
  if (status === "available") return "可用";
  if (status === "missing") return "文件缺失";
  if (status === "unsupported") return "不支持";
  return "已发现";
}

export function probeSummary(probe: MediaProbe | null): string {
  if (probe === null) return "媒体信息未知";
  if (probe.kind === "video") {
    return `${probe.width} × ${probe.height} · ${formatDurationMs(probe.durationMs)} · ${probe.videoCodec}`;
  }
  if (probe.kind === "gif") {
    return `${probe.width} × ${probe.height} · ${probe.pages} 帧 · ${formatDurationMs(probe.durationMs)}`;
  }
  return `${probe.width} × ${probe.height} · ${probe.format.toUpperCase()}`;
}

export function originLabel(origin: "source" | "manual"): string {
  return origin === "manual" ? "人工值" : "来源值";
}

export function originSummaryLabel(origins: { title: "source" | "manual"; tags: "source" | "manual" }): string {
  return origins.title === "manual" || origins.tags === "manual" ? "含人工值" : "来源值";
}

export function sourceKindLabel(kind: string): string {
  if (kind === "local_markdown") return "本地 Markdown";
  if (kind === "local_pdf") return "本地 PDF";
  if (kind === "local_pptx") return "本地 PPTX";
  if (kind === "local_html") return "本地静态 HTML";
  if (kind === "local_html_zip") return "本地 HTML ZIP";
  if (kind === "local_file") return "本地文件";
  return kind;
}

export function mappingStatusLabel(status: AssetMapSummary["status"]): string {
  switch (status) {
    case "pending": return "等待导入";
    case "applied": return "已应用";
    case "partial": return "部分应用";
    case "failed": return "未应用";
    case "skipped": return "未处理";
  }
}

export function mappingSourceStatusLabel(status: "pending" | "applied" | "failed" | "skipped"): string {
  switch (status) {
    case "pending": return "等待导入";
    case "applied": return "已应用";
    case "failed": return "未应用";
    case "skipped": return "未处理";
  }
}

export function mappingResultText(mapping: AssetMapSummary): string {
  switch (mapping.status) {
    case "pending": return "等待说明文档导入";
    case "applied": return `映射已应用 ${mapping.entryCount} 条，已关联 ${mapping.linkedEntryCount} 个素材`;
    case "partial":
    case "failed": return "媒体已导入；说明文档未应用";
    case "skipped": return "任务取消，映射未处理";
  }
}
