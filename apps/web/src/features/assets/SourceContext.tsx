import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AssetOccurrenceView } from "@dmall/contracts";
import { sourceContextQuery } from "./api.js";
import { mediaStatusLabel } from "./format.js";
import { ErrorLine, Icon, LoadingLine, useLayerFocus } from "../../ui.js";

export function SourceContextPanel({
  occurrences,
  sourceId,
  versionId,
  onClose,
}: {
  occurrences?: AssetOccurrenceView[];
  sourceId: string;
  versionId: string | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayerFocus(panel, onClose);
  const source = useQuery({
    ...sourceContextQuery(sourceId, versionId ?? undefined),
  });

  const shown = source.data === undefined ? (occurrences ?? []) : source.data.occurrences;
  return (
    <div ref={panel} tabIndex={-1} className="source-overlay" role="region" aria-label="来源文档上下文">
      <div className="source-overlay-head">
        <div>
          <span className="eyebrow">来源上下文</span>
          <h3>{source.data === undefined ? "来源文档位置" : source.data.source.title}</h3>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭来源上下文">
          <Icon name="close" />
        </button>
      </div>
      {source.isLoading ? <LoadingLine label="正在读取来源文档" /> : null}
      {source.isError ? (
        <>
          <ErrorLine message="来源暂时无法读取，可重试" />
          <div className="dialog-actions">
            <button className="button small" type="button" onClick={() => { void source.refetch(); }}>重试</button>
          </div>
        </>
      ) : null}
      {source.data === undefined ? null : (
        <>
          <p className="section-note">
            来源版本 {source.data.version.fingerprint.slice(0, 12)} · {new Date(source.data.version.capturedAt).toLocaleString("zh-CN")}
          </p>
          {source.data.document === null ? null : (
            <section className="drawer-section">
              <div className="panel-title-row">
                <h4>文档结构</h4>
                <span className={`state-pill ${source.data.document.snapshot.status === "complete" ? "ready" : "draft"}`}>
                  {source.data.document.snapshot.status === "complete" ? "抽取完整" : source.data.document.snapshot.status === "partial" ? "部分完成" : "抽取受阻"}
                </span>
              </div>
              <p className="section-note">
                {source.data.document.snapshot.processorVersion}
                {source.data.document.snapshot.pageCount === null ? "" : ` · ${source.data.document.snapshot.pageCount} 页`}
                {` · ${source.data.document.sections.length} 个章节`}
              </p>
              {source.data.document.snapshot.warnings.length === 0 ? null : (
                <div className="notice warn">
                  <Icon name="alert" />
                  <div>
                    <b>{source.data.document.snapshot.warnings.length} 条抽取提示。</b>
                    <br />
                    {source.data.document.snapshot.warnings.slice(0, 4).map((warning) => warning.message).join("；")}
                  </div>
                </div>
              )}
              <div className="occurrence-list">
                {source.data.document.sections.map((section) => (
                  <article className="occurrence" key={section.id}>
                    <div className="occurrence-head">
                      <h4>{section.title}</h4>
                      <span className="soft-pill">{locatorDetailsForLocator(section.locator)}</span>
                    </div>
                    <p className="muted small">{section.headingPath}</p>
                    {section.blocks.length === 0 ? (
                      <p className="section-note">该章节只有标题，仍可作为标题索引入口。</p>
                    ) : section.blocks.map((block) => (
                      <p className="context-text" key={block.id}>{block.text}</p>
                    ))}
                  </article>
                ))}
              </div>
            </section>
          )}
          <a className="button secondary" href={source.data.version.fileUrl} target="_blank" rel="noreferrer">
            <Icon name="source" />
            打开来源文件
          </a>
        </>
      )}
      <div className="occurrence-list">
        {shown.map((occurrence) => (
          <article className="occurrence" key={occurrence.id}>
            <div className="occurrence-head">
              <h4>{occurrence.locator.kind === "local_file" ? "导入位置" : occurrence.headingPath || "文档片段"}</h4>
              <span className={`state-pill ${occurrence.mediaStatus === "available" ? "ready" : occurrence.mediaStatus === "missing" ? "draft" : "archived"}`}>
                {mediaStatusLabel(occurrence.mediaStatus)}
              </span>
            </div>
            {occurrence.beforeText === "" ? null : <p className="context-text">{occurrence.beforeText}</p>}
            <div className="context-gap">
              <span>{occurrence.locator.kind === "local_file" ? "文件路径" : "媒体位置"}</span>
              <code>{rawTarget(occurrence)}</code>
            </div>
            {occurrence.afterText === "" ? null : <p className="context-text">{occurrence.afterText}</p>}
            <div className="raw-target">
              位置：{locatorDetails(occurrence)}
              {occurrence.errorCode === null ? "" : ` · ${occurrence.errorCode}`}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function rawTarget(occurrence: AssetOccurrenceView): string {
  if (occurrence.locator.kind === "markdown") return occurrence.locator.rawTarget;
  if (occurrence.locator.kind === "local_file") return occurrence.locator.relativePath;
  if (occurrence.locator.kind === "page") return `第 ${occurrence.locator.page} 页`;
  if (occurrence.locator.kind === "dom") return occurrence.locator.domPath;
  if (occurrence.locator.kind === "block") return occurrence.locator.blockId;
  if (occurrence.locator.kind === "time") return `${occurrence.locator.startMs}-${occurrence.locator.endMs} ms`;
  return `第 ${occurrence.locator.line} 行`;
}

export function locatorDetails(occurrence: AssetOccurrenceView): string {
  if (occurrence.locator.kind === "local_file") return occurrence.locator.relativePath;
  if (occurrence.locator.kind === "markdown") {
    return `第 ${occurrence.locator.line} 行，第 ${occurrence.locator.column} 列，第 ${occurrence.locator.ordinal + 1} 个图片来源`;
  }
  if (occurrence.locator.kind === "page") return `第 ${occurrence.locator.page} 页`;
  if (occurrence.locator.kind === "dom") return occurrence.locator.domPath;
  if (occurrence.locator.kind === "block") return `正文块 ${occurrence.locator.blockId}`;
  if (occurrence.locator.kind === "time") {
    return `片段 ${occurrence.locator.startMs}-${occurrence.locator.endMs} 毫秒`;
  }
  return `第 ${occurrence.locator.line} 行，第 ${occurrence.locator.column} 列`;
}

function locatorDetailsForLocator(locator: AssetOccurrenceView["locator"]): string {
  if (locator.kind === "local_file") return locator.relativePath;
  if (locator.kind === "markdown") return `第 ${locator.line} 行`;
  if (locator.kind === "page") return `第 ${locator.page} 页`;
  if (locator.kind === "dom") return locator.domPath;
  if (locator.kind === "block") return `正文块 ${locator.blockId}`;
  if (locator.kind === "time") return `${locator.startMs}-${locator.endMs} ms`;
  return `第 ${locator.line} 行，第 ${locator.column} 列`;
}
