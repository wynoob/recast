import { useEffect, useState, type ReactNode } from "react";
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

interface AssetOutletContext {
  health: Health | undefined;
  openTasks: () => void;
}

type TypeFilter = "all" | "video" | "gif" | "image" | "source";

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
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<{ id: string; versionId: string } | null>(null);
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [initialScanId, setInitialScanId] = useState<string | undefined>(undefined);
  const [initialImportId, setInitialImportId] = useState<string | undefined>(undefined);

  const overview = useQuery(assetListQuery({ limit: 1 }));
  const missing = useQuery(assetListQuery({ state: "missing", limit: 1 }));
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
  const mediaTotal = overview.data === undefined
    ? 0
    : overview.data.groupCounts.mp4 + overview.data.groupCounts.gif + overview.data.groupCounts.image;
  const unavailable = missing.data?.total;
  const availableCount = unavailable === undefined ? undefined : Math.max(0, mediaTotal - unavailable);
  const filtersActive =
    query !== "" ||
    type !== "all" ||
    availability !== "all" ||
    merchantFilter !== "" ||
    dateFrom !== "" ||
    dateTo !== "";

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
    setCursorStack([null]);
    setPageIndex(0);
  };

  const openSource = (source: SourceSummary) => {
    if (source.currentVersionId === null) {
      setSourceNotice("该来源没有可打开的版本");
      return;
    }
    setSourceNotice(null);
    setSelectedSource({ id: source.id, versionId: source.currentVersionId });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">素材库</span>
          <h1>让证据随时可找</h1>
          <p>素材按真实文件记录，保留来源、章节上下文和每次出现位置。没有示例素材。</p>
        </div>
        <div>
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
      </div>

      <div className="metric-grid">
        <Metric label="本地媒体" value={overview.data === undefined ? "…" : String(mediaTotal)} hint={`${overview.data?.groupCounts.mp4 ?? 0} MP4 · ${overview.data?.groupCounts.gif ?? 0} GIF · ${overview.data?.groupCounts.image ?? 0} 图片`} />
        <Metric label="可用预览" value={availableCount === undefined ? "…" : String(availableCount)} hint="原件与预览均可读取" />
        <Metric label="来源文档" value={overview.data === undefined ? "…" : String(overview.data.groupCounts.documentSources)} hint={`${overview.data?.groupCounts.missingOccurrences ?? 0} 个缺失位置`} />
        <Metric label="任务记录" value={String(tasks.length)} hint="只存任务编号，状态从服务端核对" />
      </div>

      <section className="asset-toolbar" aria-label="素材筛选">
        <label className="asset-search">
          <span className="sr-only">搜索正文、标题或标签</span>
          <Icon name="source" />
          <input
            value={searchText}
            disabled={type === "source"}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索正文、标题或标签"
          />
        </label>
        <div className="seg" role="group" aria-label="素材类型">
          <FilterButton active={type === "all"} onClick={() => changeType("all")}>全部</FilterButton>
          <FilterButton active={type === "video"} onClick={() => changeType("video")}>视频</FilterButton>
          <FilterButton active={type === "gif"} onClick={() => changeType("gif")}>GIF</FilterButton>
          <FilterButton active={type === "image"} onClick={() => changeType("image")}>图片</FilterButton>
          <FilterButton active={type === "source"} onClick={() => changeType("source")}>来源文档</FilterButton>
        </div>
        <label className="asset-state">
          <span className="sr-only">可用状态</span>
          <select
            value={availability}
            disabled={type === "source"}
            onChange={(event) => {
              setAvailability(event.target.value as "all" | "available" | "missing");
              setCursorStack([null]);
              setPageIndex(0);
            }}
          >
            <option value="all">全部状态</option>
            <option value="available">可用</option>
            <option value="missing">缺失</option>
          </select>
        </label>
        <label className="asset-state">
          <span className="sr-only">商家 UUID</span>
          <input
            value={merchantFilter}
            disabled={type === "source" && query === ""}
            onChange={(event) => setMerchantFilter(event.target.value)}
            placeholder="商家 UUID（可选）"
            spellCheck={false}
          />
        </label>
        <label className="asset-state">
          <span className="sr-only">记录日期从</span>
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className="asset-state">
          <span className="sr-only">记录日期到</span>
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
      </section>

      {overview.isError ? <ErrorLine message={overview.error.message} /> : null}
      {sourceNotice === null ? null : (
        <div className="notice info" role="status">
          <Icon name="info" />
          <div>{sourceNotice}</div>
        </div>
      )}
      {query !== "" ? (
        <SearchResults
          query={query}
          loading={search.isLoading}
          error={search.isError ? search.error.message : null}
          hits={search.data?.hits ?? []}
          capability={search.data?.capabilities.message ?? null}
          onOpen={setSelectedHandle}
        />
      ) : null}
      {query === "" && (type === "source" ? sources.isLoading : list.isLoading) ? (
        <section className="panel">
          <LoadingLine label={type === "source" ? "正在读取来源文档" : "正在读取素材库"} />
        </section>
      ) : null}
      {query === "" && type === "source" && sources.isError ? (
        <section className="panel">
          <ErrorLine message="来源文档暂时无法读取" />
          <div className="dialog-actions">
            <button className="button small" type="button" onClick={() => { void sources.refetch(); }}>重试</button>
          </div>
        </section>
      ) : null}
      {query === "" && type !== "source" && list.isError ? <section className="panel"><ErrorLine message={list.error.message} /></section> : null}

      {query === "" && type !== "source" && list.data !== undefined && overview.data?.total === 0 ? (
        <section className="empty-panel">
          <span className="empty-icon" aria-hidden="true">▧</span>
          <h2>素材库为空</h2>
          <p>还没有真实素材。导入前只做只读扫描；确认后才会复制文件。这里不会展示虚构卡片。</p>
          <button className="button primary" type="button" onClick={() => setImportOpen(true)}>＋ 导入第一份素材</button>
        </section>
      ) : null}

      {query === "" && type === "source" && sources.data !== undefined && !sources.isLoading ? (
        sources.data.items.length === 0 ? (
          <section className="empty-panel">
            <span className="empty-icon" aria-hidden="true">▤</span>
            <h2>还没有来源文档</h2>
            <p>导入 Markdown 文档后会在这里按真实来源列出。</p>
          </section>
        ) : (
          <>
            <SourceRows items={sources.data.items} onOpen={openSource} />
            <div className="pager">
              <span className="muted small">共 {sources.data.total} 份来源文档 · 第 {pageIndex + 1} 页</span>
              <div className="pager-actions">
                <button
                  className="button small"
                  type="button"
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
                >
                  上一页
                </button>
                <button
                  className="button small"
                  type="button"
                  disabled={sources.data.nextCursor === null}
                  onClick={() => {
                    if (sources.data.nextCursor === null) return;
                    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), sources.data?.nextCursor ?? null]);
                    setPageIndex((value) => value + 1);
                  }}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )
      ) : null}

      {query === "" && type !== "source" && list.data !== undefined && overview.data?.total !== 0 && !list.isLoading ? (
        list.data.items.length === 0 ? (
          <EmptyFiltered onClear={() => { setSearchText(""); setQuery(""); changeType("all"); setAvailability("all"); }} />
        ) : (
          <>
            <AssetGrid items={list.data.items} onOpen={setSelectedAssetId} />
            <div className="pager">
              <span className="muted small">共 {list.data.total} 项 · 第 {pageIndex + 1} 页{filtersActive ? "（已筛选）" : ""}</span>
              <div className="pager-actions">
                <button
                  className="button small"
                  type="button"
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
                >
                  上一页
                </button>
                <button
                  className="button small"
                  type="button"
                  disabled={list.data.nextCursor === null}
                  onClick={() => {
                    if (list.data.nextCursor === null) return;
                    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), list.data?.nextCursor ?? null]);
                    setPageIndex((value) => value + 1);
                  }}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )
      ) : null}

      {selectedAssetId !== null && health !== undefined ? (
        <AssetDetailDrawer assetId={selectedAssetId} csrfToken={health.csrfToken} onClose={() => setSelectedAssetId(null)} />
      ) : null}
      {selectedSource === null ? null : (
        <SourceContextPanel
          sourceId={selectedSource.id}
          versionId={selectedSource.versionId}
          onClose={() => setSelectedSource(null)}
        />
      )}
      {selectedHandle === null ? null : (
        <SelectionPanel
          handleId={selectedHandle}
          onClose={() => setSelectedHandle(null)}
          onOpenSource={(sourceId, versionId) => {
            setSelectedHandle(null);
            setSelectedSource({ id: sourceId, versionId });
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

function AssetGrid({ items, onOpen }: { items: AssetSummaryV2[]; onOpen: (id: string) => void }) {
  return (
    <section className="asset-grid" aria-label="素材列表">
      {items.map((asset) => (
        <button className="asset-card" type="button" key={asset.id} data-asset-id={asset.id} onClick={() => onOpen(asset.id)}>
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
            <strong>{asset.title}</strong>
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

function SourceRows({ items, onOpen }: { items: SourceSummary[]; onOpen: (source: SourceSummary) => void }) {
  return (
    <section className="source-list" aria-label="来源文档列表">
      {items.map((source) => (
        <button className="source-row" type="button" key={source.id} data-source-id={source.id} onClick={() => onOpen(source)}>
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

function SearchResults({
  query,
  loading,
  error,
  hits,
  capability,
  onOpen,
}: {
  query: string;
  loading: boolean;
  error: string | null;
  hits: SearchHit[];
  capability: string | null;
  onOpen: (handle: string) => void;
}) {
  return (
    <section className="panel search-results" aria-label="全文检索结果">
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
              className="source-row search-hit"
              type="button"
              key={hit.selectionHandle}
              onClick={() => onOpen(hit.selectionHandle)}
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

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={active ? "on" : ""} aria-pressed={active} onClick={onClick}>{children}</button>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function EmptyFiltered({ onClear }: { onClear: () => void }) {
  return (
    <section className="empty-panel">
      <span className="empty-icon" aria-hidden="true">⌕</span>
      <h2>没有符合条件的素材</h2>
      <p>当前筛选没有真实结果。清空筛选后可以继续查看已导入素材。</p>
      <button className="button" type="button" onClick={onClear}>清空筛选</button>
    </section>
  );
}
