import { useEffect, useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssetSummaryV2, Health, SearchHit, SourceSummary } from "@dmall/contracts";
import { assetListQuery, searchContent, sourceListQuery } from "./api.js";
import { AssetDetailDrawer } from "./AssetDetail.js";
import { ImportDrawer } from "./ImportDrawer.js";
import { SourceContextPanel } from "./SourceContext.js";
import { SelectionPanel } from "./SelectionPanel.js";
import {
  formatBytes,
  formatDimensions,
  formatDurationMs,
  mediaKindLabel,
  originSummaryLabel,
  sourceKindLabel,
} from "./format.js";
import { useTaskRecords } from "./task-store.js";
import { ErrorLine, Icon, LoadingLine } from "../../ui.js";
import {
  InspectorFacts,
  InspectorPanel,
  InspectorSection,
  InspectorShell,
  useInspector,
} from "../../inspector.js";

interface AssetOutletContext {
  health: Health | undefined;
  openTasks: () => void;
}

type TypeFilter = "all" | "video" | "gif" | "image" | "source";
type AssetSelection =
  | { kind: "asset"; id: string }
  | { kind: "source"; id: string }
  | { kind: "hit"; handle: string };

export function AssetLibraryPage() {
  const { health, openTasks } = useOutletContext<AssetOutletContext>();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [merchantFilter, setMerchantFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchKey, setSearchKey] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>("all");
  const [availability, setAvailability] = useState<"all" | "available" | "missing">("all");
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<AssetSelection | null>(null);
  const [detailAssetId, setDetailAssetId] = useState<string | null>(null);
  const [sourcePanel, setSourcePanel] = useState<{ id: string; versionId: string } | null>(null);
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [initialScanId, setInitialScanId] = useState<string | undefined>(undefined);
  const [initialImportId, setInitialImportId] = useState<string | undefined>(undefined);
  const inspector = useInspector("assets");

  const overview = useQuery(assetListQuery({ limit: 1 }));
  const tasks = useTaskRecords();

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(searchText.trim());
      setCursorStack([null]);
      setPageIndex(0);
    }, 280);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    setSearchKey(query === "" ? null : crypto.randomUUID());
  }, [query, type, availability, merchantFilter, dateFrom, dateTo]);

  useEffect(() => {
    const taskImport = searchParams.get("import");
    const taskScan = searchParams.get("scan");
    if (taskImport !== null) {
      setInitialImportId(taskImport);
      setInitialScanId(undefined);
      setImportOpen(true);
    } else if (taskScan !== null) {
      setInitialScanId(taskScan);
      setInitialImportId(undefined);
      setImportOpen(true);
    }
  }, [searchParams]);

  const cursor = cursorStack[pageIndex] ?? null;
  const list = useQuery({
    ...assetListQuery({
      q: query,
      ...(type === "all" || type === "source" ? {} : { type }),
      ...(availability === "all" ? {} : { state: availability }),
      limit: 12,
      cursor,
    }),
    enabled: type !== "source" && query === "",
  });
  const sources = useQuery({
    ...sourceListQuery({ limit: 20, cursor }),
    enabled: type === "source" && query === "",
  });
  const search = useQuery({
    queryKey: ["content-search", query, type, availability, merchantFilter, dateFrom, dateTo, searchKey],
    queryFn: () => searchContent({
      params: {
        query,
        merchantId: merchantFilter.trim() === "" ? null : merchantFilter.trim(),
        dateFrom: dateFrom === "" ? null : dateFrom,
        dateTo: dateTo === "" ? null : dateTo,
        mediaKinds:
          type === "video" ? ["video"]
            : type === "gif" ? ["gif"]
              : type === "image" ? ["image"]
                : type === "source" ? ["document"]
                  : [],
        availability: availability === "all" ? [] : [availability],
      },
      csrfToken: health?.csrfToken ?? "",
      idempotencyKey: searchKey ?? crypto.randomUUID(),
    }),
    enabled: query !== "" && searchKey !== null && health !== undefined,
  });

  const assetItems = useMemo(() => list.data?.items ?? [], [list.data]);
  const sourceItems = useMemo(() => sources.data?.items ?? [], [sources.data]);
  const hits = useMemo(() => search.data?.hits ?? [], [search.data]);
  const mediaTotal = overview.data === undefined
    ? 0
    : overview.data.groupCounts.mp4 + overview.data.groupCounts.gif + overview.data.groupCounts.image;
  const missingOccurrences = overview.data?.groupCounts.missingOccurrences ?? 0;
  const documentSources = overview.data?.groupCounts.documentSources ?? 0;
  const filtersActive =
    query !== "" ||
    type !== "all" ||
    availability !== "all" ||
    merchantFilter !== "" ||
    dateFrom !== "" ||
    dateTo !== "";

  const selectedAsset = selection?.kind === "asset"
    ? assetItems.find((asset) => asset.id === selection.id) ?? null
    : null;
  const selectedSource = selection?.kind === "source"
    ? sourceItems.find((source) => source.id === selection.id) ?? null
    : null;
  const selectedHit = selection?.kind === "hit"
    ? hits.find((hit) => hit.selectionHandle === selection.handle) ?? null
    : null;

  const selectionExists = selection === null
    ? false
    : selection.kind === "asset"
      ? assetItems.some((asset) => asset.id === selection.id)
      : selection.kind === "source"
        ? sourceItems.some((source) => source.id === selection.id)
        : hits.some((hit) => hit.selectionHandle === selection.handle);

  useEffect(() => {
    if (selection !== null && !selectionExists) setSelection(null);
  }, [selection, selectionExists]);

  useEffect(() => {
    if (inspector.narrow || inspector.preference !== "expanded" || selection !== null) return;
    const first = firstSelection();
    if (first !== null) setSelection(first);
  }, [assetItems, hits, inspector.narrow, inspector.preference, query, selection, sourceItems, type]);

  function firstSelection(): AssetSelection | null {
    if (query !== "") {
      const hit = hits[0];
      return hit === undefined ? null : { kind: "hit", handle: hit.selectionHandle };
    }
    if (type === "source") {
      const source = sourceItems[0];
      return source === undefined ? null : { kind: "source", id: source.id };
    }
    const asset = assetItems[0];
    return asset === undefined ? null : { kind: "asset", id: asset.id };
  }

  const select = (next: AssetSelection) => {
    setSelection(next);
    if (inspector.narrow) inspector.open();
  };

  const revealInspector = () => {
    if (inspector.expanded) {
      inspector.close();
      return;
    }
    if (selection === null) {
      const first = firstSelection();
      if (first !== null) setSelection(first);
    }
    inspector.open();
  };

  const closeImport = () => {
    setImportOpen(false);
    setInitialScanId(undefined);
    setInitialImportId(undefined);
    if (searchParams.has("import") || searchParams.has("scan")) {
      const next = new URLSearchParams(searchParams);
      next.delete("import");
      next.delete("scan");
      setSearchParams(next, { replace: true });
    }
  };

  const changeType = (next: TypeFilter) => {
    setType(next);
    setSourceNotice(null);
    setSelection(null);
    setCursorStack([null]);
    setPageIndex(0);
  };

  const selectSource = (source: SourceSummary) => {
    select({ kind: "source", id: source.id });
    if (source.currentVersionId === null) {
      setSourceNotice("该来源没有可打开的版本");
      return;
    }
    setSourceNotice(null);
  };

  const openSourcePanel = (source: SourceSummary) => {
    if (source.currentVersionId === null) {
      setSourceNotice("该来源没有可打开的版本");
      return;
    }
    setSourceNotice(null);
    setSourcePanel({ id: source.id, versionId: source.currentVersionId });
  };

  const hitCount = hits.length;
  const countLabel = query !== ""
    ? `${hitCount} 条命中`
    : type === "source"
      ? `${sources.data?.total ?? 0} 份来源文档`
      : `${list.data?.total ?? 0} 个素材`;
  const inspectorMeta = selectedAsset !== null
    ? `${mediaKindLabel(selectedAsset.mediaKind)} · ${formatBytes(selectedAsset.bytes)}`
    : selectedSource !== null
      ? `${sourceKindLabel(selectedSource.kind)} · ${selectedSource.occurrenceCount} 处引用`
      : selectedHit === null
        ? "未选择"
        : selectedHit.reason;
  const inspectorTitle = selectedAsset?.title ?? selectedSource?.title ?? selectedHit?.sourceTitle ?? selectedHit?.factId ?? undefined;

  function typeCount(value: TypeFilter): number {
    if (overview.data === undefined) return 0;
    const counts = overview.data.groupCounts;
    if (value === "video") return counts.mp4;
    if (value === "gif") return counts.gif;
    if (value === "image") return counts.image;
    if (value === "source") return counts.documentSources;
    return counts.mp4 + counts.gif + counts.image;
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>素材库</h1>
          <span className="page-summary">
            {mediaTotal} 个素材 · {documentSources} 份来源文档
            {missingOccurrences > 0 ? ` · ${missingOccurrences} 个缺失位置` : ""}
          </span>
        </div>
        <div className="page-actions">
          <button
            className="button primary"
            type="button"
            disabled={health === undefined}
            title={health === undefined ? "本地会话建立中" : undefined}
            onClick={() => { setInitialScanId(undefined); setInitialImportId(undefined); setImportOpen(true); }}
          >
            <Icon name="upload" />
            导入素材
          </button>
        </div>
      </header>

      <div className="toolbar" aria-label="素材筛选">
        <label className="search-box">
          <Icon name="search" />
          <span className="sr-only">搜索正文、标题或标签</span>
          <input
            value={searchText}
            disabled={type === "source"}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索正文、标题或标签"
            type="search"
            autoComplete="off"
          />
        </label>
        <div className="filter-group" role="group" aria-label="素材类型">
          <span className="filter-label">类型</span>
          {(["all", "video", "gif", "image", "source"] as const).map((value) => (
            <button
              className="filter-chip"
              type="button"
              key={value}
              aria-pressed={type === value}
              onClick={() => changeType(value)}
            >
              {typeLabel(value)}
              <span className="filter-count" aria-hidden="true">{typeCount(value)}</span>
            </button>
          ))}
        </div>
        <label className="select-wrap">
          <span>状态</span>
          <select
            value={availability}
            disabled={type === "source"}
            onChange={(event) => {
              setAvailability(parseAvailability(event.target.value));
              setSelection(null);
              setCursorStack([null]);
              setPageIndex(0);
            }}
            aria-label="素材可用状态"
          >
            <option value="all">全部状态</option>
            <option value="available">可用</option>
            <option value="missing">缺失</option>
          </select>
        </label>
        <details className="advanced-filters">
          <summary>更多筛选</summary>
          <div className="advanced-filter-fields">
            <label className="field">
              <span>商家 UUID（可选）</span>
              <input
                value={merchantFilter}
                disabled={type === "source" && query === ""}
                onChange={(event) => setMerchantFilter(event.target.value)}
                placeholder="商家 UUID"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>记录日期从</span>
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </label>
            <label className="field">
              <span>记录日期到</span>
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </label>
          </div>
        </details>
      </div>

      {overview.isError ? <ErrorLine message={overview.error.message} /> : null}
      {sourceNotice === null ? null : (
        <div className="notice info" role="status">
          <Icon name="info" />
          <div>{sourceNotice}</div>
        </div>
      )}

      <div className="result-bar">
        <span>
          <strong>{countLabel}</strong>
          {filtersActive ? <span className="result-note"> · 已筛选</span> : null}
          {tasks.length > 0 ? <span className="result-note"> · {tasks.length} 个本机任务</span> : null}
        </span>
        <div className="result-actions">
          <span className="result-note">{type === "source" ? "按最近更新" : "按最近导入"}</span>
          <button
            className="button small inspector-toggle"
            type="button"
            aria-expanded={inspector.expanded}
            aria-controls="asset-inspector"
            onClick={revealInspector}
          >
            {inspector.expanded ? "收起详情" : "展开详情"}
          </button>
        </div>
      </div>

      <div className={`layout${inspector.expanded ? "" : " collapsed"}`}>
        <div className="library-list">
          {query !== "" ? (
            <SearchHitList
              query={query}
              loading={search.isLoading}
              error={search.isError ? search.error.message : null}
              hits={hits}
              capability={search.data?.capabilities.message ?? null}
              selectedHandle={selectedHit?.selectionHandle ?? null}
              onSelect={(handle) => select({ kind: "hit", handle })}
            />
          ) : null}

          {query === "" && (type === "source" ? sources.isLoading : list.isLoading) ? (
            <LoadingLine label={type === "source" ? "正在读取来源文档" : "正在读取素材库"} />
          ) : null}

          {query === "" && type === "source" && sources.isError ? (
            <section className="panel">
              <ErrorLine message="来源文档暂时无法读取" />
              <div className="dialog-actions">
                <button className="button small" type="button" onClick={() => { void sources.refetch(); }}>重试</button>
              </div>
            </section>
          ) : null}
          {query === "" && type !== "source" && list.isError ? <ErrorLine message={list.error.message} /> : null}

          {query === "" && type !== "source" && list.data !== undefined && overview.data?.total === 0 ? (
            <section className="empty-panel">
              <span className="empty-icon" aria-hidden="true">▧</span>
              <h2>素材库为空</h2>
              <p>还没有素材。导入前只做只读扫描；确认后才会复制文件。</p>
              <button className="button primary" type="button" onClick={() => setImportOpen(true)}>导入第一份素材</button>
            </section>
          ) : null}

          {query === "" && type === "source" && sources.data !== undefined && !sources.isLoading ? (
            sourceItems.length === 0 ? (
              <section className="empty-panel">
                <span className="empty-icon" aria-hidden="true">▤</span>
                <h2>还没有来源文档</h2>
                <p>导入 Markdown 文档后会在这里按来源列出。</p>
              </section>
            ) : (
              <>
                <SourceRows
                  items={sourceItems}
                  selectedId={selectedSource?.id ?? null}
                  onSelect={selectSource}
                />
                <Pager
                  label={`共 ${sources.data.total} 份来源文档 · 第 ${pageIndex + 1} 页`}
                  canPrevious={pageIndex > 0}
                  nextCursor={sources.data.nextCursor}
                  onPrevious={() => setPageIndex((value) => Math.max(0, value - 1))}
                  onNext={() => {
                    if (sources.data.nextCursor === null) return;
                    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), sources.data?.nextCursor ?? null]);
                    setPageIndex((value) => value + 1);
                  }}
                />
              </>
            )
          ) : null}

          {query === "" && type !== "source" && list.data !== undefined && overview.data?.total !== 0 && !list.isLoading ? (
            assetItems.length === 0 ? (
              <EmptyFiltered onClear={() => { setSearchText(""); setQuery(""); changeType("all"); setAvailability("all"); }} />
            ) : (
              <>
                <AssetGrid
                  items={assetItems}
                  selectedId={selectedAsset?.id ?? null}
                  onSelect={(id) => select({ kind: "asset", id })}
                />
                <Pager
                  label={`共 ${list.data.total} 项 · 第 ${pageIndex + 1} 页${filtersActive ? "（已筛选）" : ""}`}
                  canPrevious={pageIndex > 0}
                  nextCursor={list.data.nextCursor}
                  onPrevious={() => setPageIndex((value) => Math.max(0, value - 1))}
                  onNext={() => {
                    if (list.data.nextCursor === null) return;
                    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), list.data?.nextCursor ?? null]);
                    setPageIndex((value) => value + 1);
                  }}
                />
              </>
            )
          ) : null}
        </div>

        <InspectorShell
          open={inspector.expanded}
          narrow={inspector.narrow}
          label="素材详情"
          onClose={inspector.close}
        >
          <InspectorPanel
            id="asset-inspector"
            label="素材检查器"
            meta={inspectorMeta}
            title={inspectorTitle}
            subtitle={
              selectedAsset !== null
                ? `${formatDimensions(selectedAsset.width, selectedAsset.height)} · ${originSummaryLabel(selectedAsset.origins)}`
                : selectedSource !== null
                  ? `${sourceKindLabel(selectedSource.kind)} · ${selectedSource.currentVersionId === null ? "没有可打开的版本" : "当前版本可打开"}`
                  : selectedHit !== null
                    ? `${selectedHit.refType === "fact" ? "事实版本" : sourceKindLabel(selectedHit.sourceKind ?? "")} · ${locatorSummary(selectedHit.locators)}`
                    : undefined
            }
            preview={
              selectedAsset !== null ? (
                selectedAsset.posterFileUrl === null
                  ? <div className="inspector-art"><Icon name={selectedAsset.mediaKind === "video" ? "video" : selectedAsset.mediaKind === "gif" ? "gif" : "image"} /></div>
                  : <img src={selectedAsset.posterFileUrl} alt="" />
              ) : selectedSource !== null ? (
                <div className="inspector-art"><Icon name="source" /></div>
              ) : (
                <div className="inspector-art"><Icon name="search" /></div>
              )
            }
            closeLabel="关闭素材详情"
            onClose={inspector.close}
            emptyTitle={query !== "" ? "没有命中的记录" : type === "source" ? "没有可查看的来源" : "没有可查看的素材"}
            emptyCopy={query !== "" ? "调整关键词或筛选后重试。" : "选择一条记录后，这里显示摘要与可用操作。"}
            actions={
              selectedAsset !== null ? (
                <>
                  <button
                    className="button primary"
                    type="button"
                    disabled={health === undefined}
                    onClick={() => setDetailAssetId(selectedAsset.id)}
                  >
                    编辑标题与标签
                  </button>
                  {selectedAsset.originalFileUrl === null ? null : (
                    <a className="button secondary" href={selectedAsset.originalFileUrl} target="_blank" rel="noreferrer">打开原文件</a>
                  )}
                </>
              ) : selectedSource !== null ? (
                <button
                  className="button primary"
                  type="button"
                  disabled={selectedSource.currentVersionId === null}
                  onClick={() => openSourcePanel(selectedSource)}
                >
                  打开来源上下文
                </button>
              ) : selectedHit !== null ? (
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setSelectedHandle(selectedHit.selectionHandle)}
                >
                  打开完整上下文
                </button>
              ) : undefined
            }
          >
            {selectedAsset !== null ? (
              <>
                <InspectorSection title="文件">
                  <InspectorFacts
                    rows={[
                      { label: "类型", value: `${mediaKindLabel(selectedAsset.mediaKind)} · ${selectedAsset.mime}` },
                      { label: "尺寸", value: formatDimensions(selectedAsset.width, selectedAsset.height) },
                      { label: "大小", value: formatBytes(selectedAsset.bytes) },
                      ...(selectedAsset.durationMs === null ? [] : [{ label: "时长", value: formatDurationMs(selectedAsset.durationMs) }]),
                      { label: "状态", value: selectedAsset.availability === "available" ? "可用" : "不可用" },
                    ]}
                  />
                </InspectorSection>
                <InspectorSection title="归属">
                  <InspectorFacts
                    rows={[
                      { label: "来源", value: `${selectedAsset.sourceCount} 个` },
                      { label: "出现位置", value: `${selectedAsset.occurrenceCount} 处` },
                      { label: "标题来源", value: selectedAsset.origins.title === "manual" ? "人工编辑" : "来源文档" },
                      { label: "标签来源", value: selectedAsset.origins.tags === "manual" ? "人工编辑" : "来源文档" },
                      { label: "导入", value: formatDate(selectedAsset.createdAt) },
                    ]}
                  />
                </InspectorSection>
                <InspectorSection title="标签">
                  {selectedAsset.tags.length === 0 ? (
                    <p className="section-note">暂无标签。</p>
                  ) : (
                    <div className="asset-tags">
                      {selectedAsset.tags.map((tag) => <span className="asset-tag" key={tag}>{tag}</span>)}
                    </div>
                  )}
                </InspectorSection>
              </>
            ) : null}
            {selectedSource !== null ? (
              <>
                <InspectorSection title="来源">
                  <InspectorFacts
                    rows={[
                      { label: "类型", value: sourceKindLabel(selectedSource.kind) },
                      { label: "状态", value: selectedSource.status === "archived" ? "已归档" : "可用" },
                      { label: "出现位置", value: `${selectedSource.occurrenceCount} 处` },
                      { label: "关联素材", value: `${selectedSource.linkedAssetCount} 个` },
                      { label: "缺失位置", value: `${selectedSource.missingOccurrenceCount} 处` },
                      { label: "最近更新", value: formatDate(selectedSource.updatedAt) },
                    ]}
                  />
                </InspectorSection>
                <InspectorSection title="下一步">
                  <p className="section-note">
                    {selectedSource.currentVersionId === null
                      ? "当前来源没有可读取的版本，无法打开章节上下文。"
                      : "打开来源上下文，查看章节、前后文和原图位置。"}
                  </p>
                </InspectorSection>
              </>
            ) : null}
            {selectedHit !== null ? (
              <>
                <InspectorSection title="命中">
                  <InspectorFacts
                    rows={[
                      { label: "类型", value: selectedHit.refType === "fact" ? "事实版本" : sourceKindLabel(selectedHit.sourceKind ?? "") },
                      { label: "原因", value: selectedHit.reason },
                      { label: "位置", value: locatorSummary(selectedHit.locators) },
                      { label: "正文块", value: selectedHit.blockIds.length === 0 ? "标题命中" : `${selectedHit.blockIds.length} 个` },
                      ...(selectedHit.keywordRank === null ? [] : [{ label: "关键词排名", value: `第 ${selectedHit.keywordRank} 名` }]),
                    ]}
                  />
                </InspectorSection>
                <InspectorSection title="命中文本">
                  <p className="context-text">{selectedHit.matchedText}</p>
                </InspectorSection>
              </>
            ) : null}
          </InspectorPanel>
        </InspectorShell>
      </div>

      {detailAssetId !== null && health !== undefined ? (
        <AssetDetailDrawer assetId={detailAssetId} csrfToken={health.csrfToken} onClose={() => setDetailAssetId(null)} />
      ) : null}
      {sourcePanel === null ? null : (
        <SourceContextPanel
          sourceId={sourcePanel.id}
          versionId={sourcePanel.versionId}
          onClose={() => setSourcePanel(null)}
        />
      )}
      {selectedHandle === null ? null : (
        <SelectionPanel
          handleId={selectedHandle}
          onClose={() => setSelectedHandle(null)}
          onOpenSource={(sourceId, versionId) => {
            setSelectedHandle(null);
            setSourcePanel({ id: sourceId, versionId });
          }}
        />
      )}
      {importOpen && health !== undefined ? (
        <ImportDrawer
          csrfToken={health.csrfToken}
          {...(initialScanId === undefined ? {} : { initialScanId })}
          {...(initialImportId === undefined ? {} : { initialImportId })}
          onClose={closeImport}
          onOpenTasks={() => { closeImport(); openTasks(); }}
          onFinished={() => {
            void queryClient.invalidateQueries({ queryKey: ["assets"] });
            void queryClient.invalidateQueries({ queryKey: ["asset"] });
            void queryClient.invalidateQueries({ queryKey: ["sources"] });
          }}
        />
      ) : null}
    </div>
  );
}

function AssetGrid({
  items,
  selectedId,
  onSelect,
}: {
  items: AssetSummaryV2[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="library-grid" aria-label="素材列表">
      {items.map((asset) => (
        <button
          className={`file-card asset-card${selectedId === asset.id ? " selected" : ""}`}
          type="button"
          key={asset.id}
          data-asset-id={asset.id}
          aria-pressed={selectedId === asset.id}
          aria-label={`查看 ${asset.title} 详情`}
          onClick={() => onSelect(asset.id)}
        >
          <span className="asset-thumb">
            {asset.posterFileUrl === null ? (
              <span className="asset-thumb-fallback"><Icon name={asset.mediaKind === "video" ? "video" : asset.mediaKind === "gif" ? "gif" : "image"} /></span>
            ) : (
              <img src={asset.posterFileUrl} alt="" loading="lazy" />
            )}
            <span className="asset-kind">{mediaKindLabel(asset.mediaKind)}</span>
            <span className="asset-origin">{originSummaryLabel(asset.origins)}</span>
            {asset.availability === "available" ? null : <span className="asset-warning">待补齐</span>}
          </span>
          <span className="asset-card-body">
            <strong className="card-title">{asset.title}</strong>
            <small>
              {asset.mediaKind === "video"
                ? `${formatDurationMs(asset.durationMs)} · ${formatDimensions(asset.width, asset.height)}`
                : `${formatDimensions(asset.width, asset.height)} · ${formatBytes(asset.bytes)}`}
            </small>
            <span className="asset-tags">
              {asset.tags.length === 0 ? <span className="muted small">暂无标签</span> : asset.tags.slice(0, 3).map((tag) => <span className="asset-tag" key={tag}>{tag}</span>)}
              {asset.tags.length > 3 ? <span className="muted small">+{asset.tags.length - 3}</span> : null}
            </span>
            <span className="asset-card-foot">
              <span>{asset.sourceCount} 个来源 · {asset.occurrenceCount} 个位置</span>
              <span>{asset.availability === "available" ? "可用" : "不可用"}</span>
            </span>
          </span>
        </button>
      ))}
    </section>
  );
}

function SourceRows({
  items,
  selectedId,
  onSelect,
}: {
  items: SourceSummary[];
  selectedId: string | null;
  onSelect: (source: SourceSummary) => void;
}) {
  return (
    <section className="source-list" aria-label="来源文档列表">
      {items.map((source) => (
        <button
          className={`source-row${selectedId === source.id ? " selected" : ""}`}
          type="button"
          key={source.id}
          data-source-id={source.id}
          aria-pressed={selectedId === source.id}
          onClick={() => onSelect(source)}
        >
          <span className="source-main">
            <strong>{source.title === "" ? "未命名来源" : source.title}</strong>
            <small>
              {sourceKindLabel(source.kind)} · {source.currentVersionId === null ? "没有可打开的版本" : "当前版本可打开"}
            </small>
          </span>
          <span className="source-counts">
            <b>{source.occurrenceCount}</b> 个位置 · <b>{source.linkedAssetCount}</b> 个素材
            {source.missingOccurrenceCount > 0 ? ` · ${source.missingOccurrenceCount} 个缺失` : ""}
          </span>
          <span className={`state-pill ${source.status === "archived" ? "archived" : "ready"}`}>
            {source.status === "archived" ? "已归档" : "可用"}
          </span>
        </button>
      ))}
    </section>
  );
}

function SearchHitList({
  query,
  loading,
  error,
  hits,
  capability,
  selectedHandle,
  onSelect,
}: {
  query: string;
  loading: boolean;
  error: string | null;
  hits: SearchHit[];
  capability: string | null;
  selectedHandle: string | null;
  onSelect: (handle: string) => void;
}) {
  return (
    <section className="search-results" aria-label="全文检索结果">
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">关键词检索</span>
          <h2>“{query}”的本地命中</h2>
        </div>
        <span className="soft-pill">{hits.length} 条</span>
      </div>
      {capability === null ? null : <p className="section-note">{capability}</p>}
      {loading ? <LoadingLine label="正在检索正文、标题和标签" /> : null}
      {error === null ? null : <ErrorLine message={error} />}
      {!loading && error === null && hits.length === 0 ? (
        <div className="empty-panel compact-empty">
          <span className="empty-icon" aria-hidden="true">⌕</span>
          <h2>没有命中</h2>
          <p>当前关键词和硬过滤没有返回本地索引结果。清空筛选后可重试。</p>
        </div>
      ) : null}
      {hits.length === 0 ? null : (
        <div className="source-list">
          {hits.map((hit) => (
            <button
              className={`source-row search-hit${selectedHandle === hit.selectionHandle ? " selected" : ""}`}
              type="button"
              key={hit.selectionHandle}
              aria-pressed={selectedHandle === hit.selectionHandle}
              onClick={() => onSelect(hit.selectionHandle)}
            >
              <span className="source-main">
                <strong>{hit.sourceTitle ?? hit.factId ?? "事实命中"}</strong>
                <small>{hit.refType === "fact" ? "事实版本" : sourceKindLabel(hit.sourceKind ?? "")} · {hit.reason}</small>
                <span className="context-text search-excerpt">{hit.matchedText}</span>
                <small>{locatorSummary(hit.locators)}</small>
              </span>
              <span className="source-counts">
                {hit.keywordRank === null ? "" : `关键词第 ${hit.keywordRank} 名`}
                {hit.blockIds.length === 0 ? " · 标题命中" : ` · ${hit.blockIds.length} 个正文块`}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Pager({
  label,
  canPrevious,
  nextCursor,
  onPrevious,
  onNext,
}: {
  label: string;
  canPrevious: boolean;
  nextCursor: string | null;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="pager">
      <span className="muted small">{label}</span>
      <div className="pager-actions">
        <button className="button small" type="button" disabled={!canPrevious} onClick={onPrevious}>上一页</button>
        <button className="button small" type="button" disabled={nextCursor === null} onClick={onNext}>下一页</button>
      </div>
    </div>
  );
}

function EmptyFiltered({ onClear }: { onClear: () => void }) {
  return (
    <section className="empty-panel">
      <span className="empty-icon" aria-hidden="true">⌕</span>
      <h2>没有符合条件的素材</h2>
      <p>当前筛选没有结果。清空筛选后可以继续查看已导入素材。</p>
      <button className="button" type="button" onClick={onClear}>清空筛选</button>
    </section>
  );
}

function typeLabel(value: TypeFilter): string {
  if (value === "video") return "视频";
  if (value === "gif") return "GIF";
  if (value === "image") return "图片";
  if (value === "source") return "来源文档";
  return "全部";
}

function parseAvailability(value: string): "all" | "available" | "missing" {
  return value === "available" || value === "missing" ? value : "all";
}

function locatorShortLabel(locator: SearchHit["locators"][number]): string {
  switch (locator.kind) {
    case "page":
      return `第 ${locator.page} 页`;
    case "dom":
      return locator.domPath;
    case "block":
      return `块 ${locator.blockId.slice(0, 8)}`;
    case "markdown":
    case "markdown_text":
      return `第 ${locator.line} 行`;
    case "local_file":
      return locator.relativePath;
    case "time":
      return `${locator.startMs}-${locator.endMs} ms`;
  }
}

function locatorSummary(locators: SearchHit["locators"]): string {
  const labels = [...new Set(locators.map(locatorShortLabel))];
  if (labels.length <= 6) return labels.join(" · ");
  return `${labels.slice(0, 5).join(" · ")} 等 ${labels.length} 处`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
