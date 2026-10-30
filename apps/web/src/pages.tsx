import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ContentKind, ContentSummary, Health } from "@dmall/contracts";
import { contentsQuery } from "./api.js";
import { ErrorLine, Icon, LoadingLine } from "./ui.js";
import { AssetLibraryPage } from "./features/assets/AssetLibraryPage.js";
import {
  InspectorFacts,
  InspectorPanel,
  InspectorSection,
  InspectorShell,
  useInspector,
} from "./inspector.js";

interface OutletContext {
  openNew: () => void;
  health: Health | undefined;
}

type ContentFilter = "all" | "draft" | "ready" | "archived";

export function ContentsPage() {
  const { openNew } = useOutletContext<OutletContext>();
  const contents = useQuery(contentsQuery);
  const [searchText, setSearchText] = useState("");
  const [filter, setFilter] = useState<ContentFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inspector = useInspector("contents");

  const items = contents.data?.items ?? [];
  const filtered = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== "all" && item.status !== filter) return false;
      return query === "" || item.title.toLowerCase().includes(query);
    });
  }, [items, filter, searchText]);
  const selected = filtered.find((item) => item.id === selectedId) ?? null;
  const total = contents.data?.total ?? 0;
  const hasMore = contents.data?.nextCursor != null;

  useEffect(() => {
    if (selectedId !== null && !filtered.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [filtered, selectedId]);

  useEffect(() => {
    if (inspector.narrow || inspector.preference !== "expanded" || selectedId !== null) return;
    const first = filtered[0];
    if (first !== undefined) setSelectedId(first.id);
  }, [filtered, inspector.narrow, inspector.preference, selectedId]);

  const select = (id: string) => {
    setSelectedId(id);
    if (inspector.narrow) inspector.open();
  };
  const revealInspector = () => {
    if (inspector.expanded) {
      inspector.close();
      return;
    }
    if (selectedId === null && filtered[0] !== undefined) setSelectedId(filtered[0].id);
    inspector.open();
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>内容库</h1>
          <span className="page-summary">{total} 份内容 · 文档与演示统一管理</span>
        </div>
        <div className="page-actions">
          <button className="button primary" type="button" onClick={openNew}>
            <Icon name="plus" />
            新建内容
          </button>
        </div>
      </header>

      <div className="toolbar" aria-label="内容筛选">
        <label className="search-box">
          <Icon name="search" />
          <span className="sr-only">搜索内容标题</span>
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索内容标题"
            aria-label="搜索内容标题"
            autoComplete="off"
          />
        </label>
        <div className="filter-group" role="group" aria-label="内容状态">
          <span className="filter-label">状态</span>
          {(["all", "draft", "ready", "archived"] as const).map((value) => (
            <button
              className="filter-chip"
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === "all" ? "全部" : statusLabel(value)}
              <span className="filter-count" aria-hidden="true">{countByStatus(items, value)}</span>
            </button>
          ))}
        </div>
      </div>

      {hasMore ? <p className="section-note" role="status">当前显示最新的 {items.length} 份内容，共 {total} 份。搜索与状态筛选仅作用于已显示的内容。</p> : null}

      <div className="result-bar">
        <span>
          <strong>{filtered.length} 份内容</strong>
          {filter === "all" && searchText.trim() === "" ? null : <span className="result-note"> · 已筛选</span>}
        </span>
        <div className="result-actions">
          <span className="result-note">按最近更新</span>
          <button
            className="button small inspector-toggle"
            type="button"
            aria-expanded={inspector.expanded}
            aria-controls="content-inspector"
            onClick={revealInspector}
          >
            {inspector.expanded ? "收起详情" : "展开详情"}
          </button>
        </div>
      </div>

      <div className={`layout${inspector.expanded ? "" : " collapsed"}`}>
        <div className="library-list">
          {contents.isLoading ? <LoadingLine label="正在读取内容库" /> : null}
          {contents.isError ? <ErrorLine message={contents.error.message} /> : null}
          {contents.data !== undefined && total === 0 ? (
            <EmptyPanel
              title="内容列表为空"
              copy="开始一次 AI 创作。旧内容和历史成品仍会保留。"
              action={<button className="button primary" type="button" onClick={openNew}>建立第一份内容</button>}
            />
          ) : null}
          {contents.data !== undefined && total > 0 && filtered.length === 0 ? (
            <EmptyPanel
              title="没有符合条件的内容"
              copy="当前搜索或状态筛选没有结果。清空筛选后可以继续查看内容。"
              action={
                <button
                  className="button"
                  type="button"
                  onClick={() => { setSearchText(""); setFilter("all"); }}
                >
                  清空筛选
                </button>
              }
            />
          ) : null}
          {filtered.length > 0 ? (
            <div className="library-grid" aria-label="内容列表">
              {filtered.map((item) => (
                <button
                  className={`file-card content-card${selectedId === item.id ? " selected" : ""}`}
                  type="button"
                  key={item.id}
                  aria-pressed={selectedId === item.id}
                  aria-label={`查看 ${item.title} 详情`}
                  onClick={() => select(item.id)}
                >
                  <div className="card-topline">
                    <span className={`state-pill ${item.status}`}>{statusLabel(item.status)}</span>
                    <span className="muted small">{formatDate(item.updatedAt)}</span>
                  </div>
                  <span className="card-title">{item.title}</span>
                  <div className="format-row">
                    {item.kinds.map((kind) => <span className="kind-pill" key={kind}>{kindLabel(kind)}</span>)}
                  </div>
                  <div className="card-footer">
                    <span>版本 {item.version + 1}</span>
                    <span>{item.renditionCount} 个交付分支</span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <InspectorShell
          open={inspector.expanded}
          narrow={inspector.narrow}
          label="内容详情"
          onClose={inspector.close}
        >
          <InspectorPanel
            id="content-inspector"
            label="内容检查器"
            meta={selected === null ? "未选择" : `${selected.renditionCount} 个交付分支`}
            title={selected?.title}
            subtitle={selected === null ? undefined : `更新于 ${formatDate(selected.updatedAt)}`}
            preview={<div className="inspector-art"><Icon name="content" /></div>}
            closeLabel="关闭内容详情"
            onClose={inspector.close}
            emptyTitle="没有可查看的内容"
            emptyCopy="选择一份内容后，这里显示摘要与下一步动作。"
            actions={selected === null ? undefined : (
              <>
                <Link className="button primary" to={`/contents/${selected.id}`}>继续创作</Link>
                <Link className="button secondary" to={`/contents/${selected.id}/history`}>查看历史</Link>
              </>
            )}
          >
            {selected === null ? null : (
              <>
                <InspectorSection title="摘要">
                  <InspectorFacts
                    rows={[
                      { label: "状态", value: statusLabel(selected.status) },
                      { label: "交付格式", value: selected.kinds.map(kindLabel).join(" · ") },
                      { label: "版本", value: String(selected.version + 1) },
                      { label: "创建", value: formatDate(selected.createdAt) },
                      { label: "最近更新", value: formatDate(selected.updatedAt) },
                    ]}
                  />
                </InspectorSection>
                <InspectorSection title="下一步">
                  <p className="section-note">打开内容继续创作，或查看只读的历史记录。</p>
                </InspectorSection>
              </>
            )}
          </InspectorPanel>
        </InspectorShell>
      </div>
    </div>
  );
}

export function AssetsPage() {
  return <AssetLibraryPage />;
}

function EmptyPanel({ title, copy, action }: { title: string; copy: string; action: ReactNode }) {
  return (
    <section className="empty-panel">
      <span className="empty-icon" aria-hidden="true">◇</span>
      <h2>{title}</h2>
      <p>{copy}</p>
      <div>{action}</div>
    </section>
  );
}

function countByStatus(items: ContentSummary[], filter: ContentFilter): number {
  return filter === "all" ? items.length : items.filter((item) => item.status === filter).length;
}

function kindLabel(kind: ContentKind): string {
  return kind === "feishu_doc" ? "飞书文档" : "HTML 演示";
}

function statusLabel(status: "draft" | "ready" | "archived"): string {
  return status === "draft" ? "草稿" : status === "ready" ? "已就绪" : "已归档";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
