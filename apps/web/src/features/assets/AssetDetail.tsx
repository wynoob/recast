import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { AssetOccurrenceView, AssetSummaryV2 } from "@dmall/contracts";
import { assetDetailQuery } from "./api.js";
import { AssetEdit } from "./AssetEdit.js";
import { AssetMedia } from "./AssetMedia.js";
import { AssetDocumentExcerpt, AssetSourceDocument, AssetSources } from "./AssetSources.js";
import { formatBytes, formatDimensions, formatDurationMs, mediaKindLabel } from "./format.js";
import { ErrorLine, LoadingLine, useLayerFocus } from "../../ui.js";
import "./asset-library.css";

type PreviewView =
  | { kind: "media" }
  | { kind: "occurrence"; occurrence: AssetOccurrenceView }
  | { kind: "document"; sourceId: string; versionId: string };

export function AssetDetailDrawer({ assetId, csrfToken, items = [], onNavigate, onClose }: {
  assetId: string;
  csrfToken: string;
  items?: AssetSummaryV2[];
  onNavigate?: (id: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const detail = useQuery(assetDetailQuery(assetId));
  const [view, setView] = useState<PreviewView>({ kind: "media" });
  const [tab, setTab] = useState<"overview" | "source">("overview");
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editState, setEditState] = useState({ dirty: false, pending: false });
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const index = items.findIndex((item) => item.id === assetId);
  const data = detail.data;

  const updateEditState = useCallback((dirty: boolean, pending: boolean) => {
    setEditState({ dirty, pending });
  }, []);
  const requestLeave = useCallback((action: () => void) => {
    if (editState.pending) return;
    if (editState.dirty) setLeaveAction(() => action);
    else action();
  }, [editState]);
  const showView = (next: PreviewView) => {
    setView(next);
    requestAnimationFrame(() => {
      const media = panel.current?.querySelector<HTMLElement>(".asset-viewer-media");
      panel.current?.scrollTo({ top: 0 });
      media?.querySelector<HTMLButtonElement>(".asset-source-document > button")?.focus({ preventScroll: true });
    });
  };
  const back = () => {
    if (leaveAction !== null) setLeaveAction(null);
    else if (view.kind !== "media") setView({ kind: "media" });
    else requestLeave(onClose);
  };
  useLayerFocus(panel, back);
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".asset-shell");
    if (shell === null) return;
    const wasInert = shell.inert;
    shell.inert = true;
    return () => {
      shell.inert = wasInert;
      opener.current?.focus({ preventScroll: true });
    };
  }, []);

  const navigate = useCallback((id: string) => {
    if (onNavigate === undefined || id === assetId) return;
    requestLeave(() => {
      setEditing(false);
      setEditState({ dirty: false, pending: false });
      setView({ kind: "media" });
      setLeaveAction(null);
      onNavigate(id);
    });
  }, [assetId, onNavigate, requestLeave]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || leaveAction !== null) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input,textarea,select,video,[contenteditable=true],[role=tablist],.asset-media-stage-actual")) return;
      const next = items[index + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0)];
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && next !== undefined) {
        event.preventDefault();
        navigate(next.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, items, navigate, leaveAction]);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(".asset-film-item[aria-pressed=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [assetId]);

  return createPortal(
    <section ref={panel} tabIndex={-1} className={`asset-viewer${focused ? " is-focused" : ""}`} role="dialog" aria-modal="true" aria-label="素材预览">
      <header className="asset-viewer-header">
        <button className="button asset-back" type="button" onClick={() => requestLeave(onClose)}>← 返回素材库</button>
        <div className="asset-viewer-nav" aria-label="连续浏览">
          <span>{index < 0 ? "" : `${index + 1} / ${items.length}`}</span>
          <button className="button" type="button" aria-label="上一项" disabled={index <= 0 || editState.pending} onClick={() => { const item = items[index - 1]; if (item) navigate(item.id); }}>←</button>
          <button className="button" type="button" aria-label="下一项" disabled={index < 0 || index >= items.length - 1 || editState.pending} onClick={() => { const item = items[index + 1]; if (item) navigate(item.id); }}>→</button>
        </div>
      </header>
      <div className="asset-viewer-title">
        <div><h1>{data?.summary.title ?? "素材预览"}</h1><p>{data === undefined ? "正在读取原件与信息" : `${mediaKindLabel(data.summary.mediaKind)} · ${formatDimensions(data.summary.width, data.summary.height)} · ${formatBytes(data.summary.bytes)}${data.summary.mediaKind === "video" ? ` · ${formatDurationMs(data.summary.durationMs)}` : ""}`}</p></div>
        <button className="button" type="button" aria-pressed={focused} onClick={() => setFocused((value) => !value)}>{focused ? "显示信息" : "专注预览"}</button>
      </div>
      {leaveAction === null ? null : <div className="asset-unsaved" role="alert"><p>标题或标签有未保存的修改。</p><button className="button" type="button" onClick={() => setLeaveAction(null)}>继续编辑</button><button className="button" type="button" onClick={() => { setLeaveAction(null); setEditing(false); setEditState({ dirty: false, pending: false }); leaveAction(); }}>放弃未保存修改</button></div>}
      {detail.isLoading ? <LoadingLine label="正在打开素材" /> : null}
      {detail.isError ? <div><ErrorLine message={detail.error.message} /><button className="button" type="button" onClick={() => { void detail.refetch(); }}>重试</button></div> : null}
      {data === undefined ? null : <div className="asset-viewer-layout">
        <div className="asset-viewer-media">
          {view.kind === "media" ? <AssetMedia key={assetId} data={data} /> : view.kind === "occurrence" ? <AssetDocumentExcerpt occurrence={view.occurrence} onBack={() => setView({ kind: "media" })} posterUrl={data.summary.posterFileUrl} title={data.summary.title} /> : <AssetSourceDocument sourceId={view.sourceId} versionId={view.versionId} onBack={() => setView({ kind: "media" })} />}
          <nav className="asset-filmstrip" aria-label="本页素材">
            {items.map((item) => <button className="asset-film-item" type="button" key={item.id} aria-label={`预览${item.title}`} aria-pressed={item.id === assetId} disabled={editState.pending} onClick={() => navigate(item.id)}>{item.posterFileUrl === null ? <span className="asset-film-fallback">{mediaKindLabel(item.mediaKind)}</span> : <img src={item.posterFileUrl} alt="" />}<span>{item.title}</span></button>)}
          </nav>
        </div>
        <aside className="asset-properties" hidden={focused} aria-label="素材信息">
          <div className="asset-detail-tabs" role="tablist" aria-label="素材信息分类">
            <button id="asset-overview-tab" role="tab" type="button" aria-selected={tab === "overview"} aria-controls="asset-overview" onClick={() => setTab("overview")}>概览</button>
            <button id="asset-source-tab" role="tab" type="button" aria-selected={tab === "source"} aria-controls="asset-source" onClick={() => setTab("source")}>来源</button>
          </div>
          <div id="asset-overview" role="tabpanel" aria-labelledby="asset-overview-tab" hidden={tab !== "overview"}>
            <section className="asset-property-section"><h2>适合怎样使用</h2><p className="asset-usage">{data.sourceSuggestion?.usageText ?? "暂无用途说明。可先查看画面与文件信息。"}</p>{data.sourceSuggestion === null ? null : <p className="asset-property-note">来自「{data.sourceSuggestion.provenance.sourceTitle}」的说明，内容需结合实际场景核对。</p>}</section>
            <section className="asset-property-section"><h2>文件信息</h2><dl className="asset-file-facts"><div><dt>类型</dt><dd>{data.summary.mime}</dd></div><div><dt>大小</dt><dd>{formatBytes(data.summary.bytes)}</dd></div><div><dt>尺寸</dt><dd>{formatDimensions(data.summary.width, data.summary.height)}</dd></div><div><dt>{data.summary.mediaKind === "video" ? "原件时长" : "导入日期"}</dt><dd>{data.summary.mediaKind === "video" ? formatDurationMs(data.summary.durationMs) : data.summary.createdAt.slice(0, 10)}</dd></div></dl>{data.metadata.extensionMismatch ? <p className="asset-property-note">扩展名与文件格式不一致，实际为 {data.metadata.magicMime}。</p> : null}{data.summary.availability === "available" ? <span className="asset-property-note">原件与预览可读取</span> : <p className="asset-property-note">文件或预览需要补齐。</p>}</section>
            <section className="asset-property-section"><h2>标签</h2><div className="asset-tags">{data.humanFields.tags.length ? data.humanFields.tags.map((tag) => <span className="asset-tag" key={tag}>{tag}</span>) : <span className="muted">暂无标签</span>}</div><button className="asset-text-button" type="button" aria-expanded={editing} onClick={() => requestLeave(() => setEditing(!editing))}>{editing ? "收起编辑" : "编辑标题与标签"}</button><div hidden={!editing}>{editing ? <AssetEdit key={assetId} data={data} csrfToken={csrfToken} onDirtyChange={updateEditState} /> : null}</div></section>
            <section className="asset-property-section"><h2>出处</h2><p className="asset-property-note">{data.occurrences.find((item) => item.locator.kind !== "local_file")?.sourceTitle ?? "本地文件导入"}</p><button className="asset-text-button" type="button" onClick={() => setTab("source")}>查看导入位置与文档依据</button></section>
          </div>
          <div id="asset-source" role="tabpanel" aria-labelledby="asset-source-tab" hidden={tab !== "source"}><AssetSources data={data} onShowOccurrence={(occurrence) => showView({ kind: "occurrence", occurrence })} onShowSource={(sourceId, versionId) => showView({ kind: "document", sourceId, versionId })} /></div>
        </aside>
      </div>}
    </section>, document.body,
  );
}
