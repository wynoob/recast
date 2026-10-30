import { useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { Locator, SelectionView } from "@dmall/contracts";
import { selectionQuery } from "./api.js";
import { ErrorLine, Icon, LoadingLine, useLayerFocus } from "../../ui.js";

export function SelectionPanel({
  handleId,
  onOpenSource,
  onClose,
}: {
  handleId: string;
  onOpenSource: (sourceId: string, versionId: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayerFocus(panel, onClose);
  const selection = useQuery(selectionQuery(handleId));
  return createPortal(
    <div className="source-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} tabIndex={-1} className="source-overlay selection-overlay" role="dialog" aria-modal="true" aria-label="检索选择详情">
      <div className="source-overlay-head">
        <div>
          <span className="eyebrow">命中来源</span>
          <h3>{selection.data?.sourceTitle ?? (selection.data?.fact === null ? "事实" : "检索选择")}</h3>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭检索选择详情">
          <Icon name="close" />
        </button>
      </div>
      {selection.isLoading ? <LoadingLine label="正在读取完整来源位置" /> : null}
      {selection.isError ? <ErrorLine message={selection.error.message} /> : null}
      {selection.data === undefined ? null : (
        <SelectionContent selection={selection.data} onOpenSource={onOpenSource} />
      )}
    </div>
    </div>,
    document.body,
  );
}

function SelectionContent({
  selection,
  onOpenSource,
}: {
  selection: SelectionView;
  onOpenSource: (sourceId: string, versionId: string) => void;
}) {
  if (selection.fact !== null) {
    const fact = selection.fact.currentVersion;
    return (
      <>
        <p className="section-note">
          {selection.fact.canonicalKey} · 第 {fact.version} 版 · {fact.status === "confirmed" ? "已确认" : fact.status === "obsolete" ? "已过时" : "未确认"}
        </p>
        <dl className="detail-list two-column">
          <div><dt>数值</dt><dd>{typeof fact.value === "number" ? String(fact.value) : fact.value}</dd></div>
          <div><dt>单位</dt><dd>{fact.unit}</dd></div>
          <div><dt>口径</dt><dd>{fact.kind === "measured" ? "实测" : fact.kind === "estimated" ? "测算" : "用户陈述"}</dd></div>
          <div><dt>商家</dt><dd>{fact.merchantId ?? "未限定"}</dd></div>
          <div><dt>期间</dt><dd>{fact.period === null ? "未指定" : `${fact.period.start} 至 ${fact.period.end}`}</dd></div>
          <div><dt>来源版本</dt><dd>{fact.sourceVersionId}</dd></div>
        </dl>
        <div className="drawer-section">
          <h4>完整事实文本</h4>
          <pre className="usage-raw">{fact.indexText}</pre>
        </div>
        <div className="raw-target">定位：{locatorLabel(fact.sourceLocator)}</div>
        {selection.sourceId === null || selection.sourceVersionId === null ? null : (
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              if (selection.sourceId !== null && selection.sourceVersionId !== null) {
                onOpenSource(selection.sourceId, selection.sourceVersionId);
              }
            }}
          >
            在来源面板打开
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <p className="section-note">
        {selection.sourceTitle ?? "未知来源"} · 版本 {selection.sourceVersionId?.slice(0, 12) ?? "未知"} · {selection.blocks.length} 个正文块
      </p>
      {selection.section === null ? null : (
        <div className="drawer-section">
          <h4>{selection.section.title}</h4>
          <p className="muted small">{selection.section.headingPath}</p>
        </div>
      )}
      <div className="occurrence-list">
        {selection.blocks.length === 0 ? (
          <article className="occurrence">
            <p className="section-note">该命中是标题章节，没有正文块。</p>
          </article>
        ) : selection.blocks.map((block) => (
          <article className="occurrence" key={block.id}>
            <div className="occurrence-head">
              <h4>正文块 {block.ordinal}</h4>
              <span className="soft-pill">{locatorLabel(block.locator)}</span>
            </div>
            <p className="context-text">{block.text}</p>
          </article>
        ))}
      </div>
      <div className="dialog-actions wrap">
        {selection.sourceId === null || selection.sourceVersionId === null ? null : (
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              if (selection.sourceId !== null && selection.sourceVersionId !== null) {
                onOpenSource(selection.sourceId, selection.sourceVersionId);
              }
            }}
          >
            打开完整来源
          </button>
        )}
        {selection.sourceFileUrl === null ? null : (
          <a className="button" href={selection.sourceFileUrl} target="_blank" rel="noreferrer">打开来源原文件</a>
        )}
      </div>
    </>
  );
}

function locatorLabel(locator: Locator): string {
  switch (locator.kind) {
    case "page":
      return `第 ${locator.page} 页`;
    case "dom":
      return locator.domPath;
    case "block":
      return `正文块 ${locator.blockId}`;
    case "markdown":
      return `第 ${locator.line} 行第 ${locator.column} 列`;
    case "markdown_text":
      return `第 ${locator.line} 行第 ${locator.column} 列`;
    case "local_file":
      return locator.relativePath;
    case "time":
      return `${locator.startMs}-${locator.endMs} 毫秒`;
  }
}
