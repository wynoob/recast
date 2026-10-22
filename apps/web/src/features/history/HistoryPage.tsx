import { Link, useParams, useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Block, ContentDetail, Provenance, RevisionEvidence } from "@dmall/contracts";
import { contentQuery } from "../../api.js";
import { ErrorLine, LoadingLine } from "../../ui.js";
import { assetDetailQuery } from "../assets/api.js";
import { historyExports, historyRevision, historyRevisions } from "./api.js";

export function HistoryPage() {
  const { id, renditionId } = useParams();
  const [params, setParams] = useSearchParams();
  const content = useQuery({ ...contentQuery(id ?? ""), enabled: id !== undefined });
  const outputs = useInfiniteQuery({
    queryKey: ["history-outputs", id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => historyExports(id ?? "", pageParam),
    getNextPageParam: (page) => page.nextCursor,
    enabled: id !== undefined,
  });
  if (content.isLoading) return <LoadingLine label="正在读取历史内容" />;
  if (content.isError) return <ErrorLine message={content.error.message} />;
  if (content.data === undefined) return null;
  const detail = content.data;
  const requestedRendition = renditionId ?? params.get("renditionId");
  const revisionId = params.get("revisionId");
  const selected = requestedRendition === null || requestedRendition === undefined
    ? detail.renditions.find((item) => item.currentRevisionId === revisionId) ?? detail.renditions[0]
    : detail.renditions.find((item) => item.id === requestedRendition);
  const records = outputs.data?.pages.flatMap((page) => page.items) ?? [];
  return <div className="page history-page">
    <div className="breadcrumb"><Link to="/contents">内容库</Link><span>/</span><span>只读历史</span></div>
    <div className="page-header"><div><span className="eyebrow">只读历史</span><h1>{detail.title}</h1><p>查看原修订、来源与成品。正文修改请在飞书中完成。</p></div><Link className="button primary" to="/compose">开始新创作</Link></div>
    <nav className="history-renditions" aria-label="历史分支">{detail.renditions.map((item) => <Link className={`button ${selected?.id === item.id ? "primary" : "secondary"}`} key={item.id} to={`/contents/${detail.id}/edit/${item.id}`}>{item.label} · {item.kind === "feishu_doc" ? "文档" : "演示"}</Link>)}</nav>
    {selected === undefined ? <ErrorLine message="该历史分支不存在" /> : <RevisionHistory key={selected.id} rendition={selected} revisionId={revisionId} onSelect={(value) => { const next = new URLSearchParams(params); next.set("revisionId", value); next.set("renditionId", selected.id); setParams(next); }} />}
    <section className="panel history-outputs"><h2>全部历史成品</h2>{outputs.isLoading ? <LoadingLine label="正在读取成品" /> : null}{outputs.isError ? <ErrorLine message={outputs.error.message} /> : null}
      {records.length === 0 && outputs.isSuccess ? <p>尚无历史输出。</p> : records.map((record) => <article className="history-output" key={record.id}><h3>{record.title}</h3><p>{record.renditionLabel} · {record.format} · {outputStatus[record.status]}</p><p className="muted small">修订 {record.revisionId} · {new Date(record.createdAt).toLocaleString("zh-CN")}</p>
        {record.remoteUrl === null ? null : <a className="button secondary" target="_blank" rel="noreferrer" href={record.remoteUrl}>{record.status === "succeeded" ? "打开飞书文档" : "查看远端记录（尚未完整交付）"}</a>}
        <div className="dialog-actions wrap">{record.artifacts.map((artifact) => <a className="button secondary" key={artifact.id} href={artifact.downloadUrl} download={artifact.fileName}>下载 {artifact.fileName}</a>)}</div>{record.error === null ? null : <p>{record.error.message}</p>}
      </article>)}
      {outputs.hasNextPage ? <button className="button secondary" disabled={outputs.isFetchingNextPage} onClick={() => { void outputs.fetchNextPage(); }}>加载更多历史成品</button> : null}
    </section>
  </div>;
}

const outputStatus = { queued: "等待中", running: "执行中", waiting_input: "等待处理", succeeded: "已完成", partial: "部分完成", failed: "失败", blocked: "已阻塞", cancelled: "已取消" };

function RevisionHistory({ rendition, revisionId, onSelect }: { rendition: ContentDetail["renditions"][number]; revisionId: string | null; onSelect: (id: string) => void }) {
  const revisions = useInfiniteQuery({
    queryKey: ["history-revisions", rendition.id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => historyRevisions(rendition.id, pageParam),
    getNextPageParam: (page) => page.nextCursor,
  });
  const revision = useQuery({ queryKey: ["history-revision", rendition.id, revisionId ?? rendition.currentRevisionId], queryFn: () => historyRevision(rendition.id, revisionId ?? rendition.currentRevisionId) });
  const ast = revision.data?.ast;
  const groups = ast === undefined ? [] : ast.kind === "feishu_doc" ? ast.sections : ast.slides;
  return <div className="history-grid"><aside className="panel"><h2>修订历史</h2>{revisions.isLoading ? <LoadingLine label="正在读取修订" /> : null}{revisions.isError ? <ErrorLine message={revisions.error.message} /> : null}
    {revisions.data?.pages.flatMap((page) => page.items).map((item) => <button className={`history-revision${(revisionId ?? rendition.currentRevisionId) === item.id ? " selected" : ""}`} key={item.id} onClick={() => onSelect(item.id)}><b>{item.reason || "修订"}</b><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.createdBy}</small></button>)}
    {revisions.hasNextPage ? <button className="button secondary" disabled={revisions.isFetchingNextPage} onClick={() => { void revisions.fetchNextPage(); }}>加载更多修订</button> : null}</aside>
    <section className="panel history-body"><h2>{ast?.title ?? "修订正文"}</h2>{revision.isLoading ? <LoadingLine label="正在读取正文与来源" /> : null}{revision.isError ? <ErrorLine message={revision.error.message} /> : null}
      {groups.map((group) => <section key={group.id}><h3>{group.title}</h3>{group.blocks.map((block) => <ReadOnlyBlock key={block.id} block={block} bindings={revision.data?.evidence.kind === "resolved" || revision.data?.evidence.kind === "empty" ? revision.data.evidence.evidence.bindings : []} />)}{"speakerNotes" in group && typeof group.speakerNotes === "string" && group.speakerNotes ? <details><summary>讲稿</summary><p>{group.speakerNotes}</p></details> : null}</section>)}
      {revision.data === undefined ? null : <details className="composer-plan-section"><summary>来源关系与可用性</summary>{revision.data.evidence.kind === "unresolved" ? <p>历史来源尚未解析。</p> : null}{revision.data.references.map((item, index) => <p className="muted small" key={index}>{item.ref.refType} · {item.ref.refId} · {item.state.kind === "available" ? "可用" : item.state.reason}</p>)}</details>}
    </section>
  </div>;
}

function ReadOnlyBlock({ block, bindings }: { block: Block; bindings: RevisionEvidence["bindings"] }) {
  let body;
  switch (block.type) {
    case "heading": body = <h4>{block.text}</h4>; break;
    case "paragraph": case "callout": body = <p>{block.inlines.map((inline) => inline.text).join("")}</p>; break;
    case "list": body = block.ordered ? <ol>{block.items.map((item, index) => <li key={index}>{item.map((inline) => inline.text).join("")}</li>)}</ol> : <ul>{block.items.map((item, index) => <li key={index}>{item.map((inline) => inline.text).join("")}</li>)}</ul>; break;
    case "table": body = <div className="history-table"><table><thead><tr>{block.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell.map((inline) => inline.text).join("")}</td>)}</tr>)}</tbody></table></div>; break;
    case "image": case "video": {
      const binding = block.type === "image" ? bindings.find((item) => item.requestedOccurrenceId === block.occurrenceId || item.canonicalOccurrenceId === block.occurrenceId) : undefined;
      body = <HistoryMedia block={block} assetId={binding?.assetIdAtCapture ?? null} />;
      break;
    }
    case "readonly_source_block": body = <p>{block.summary} <a href={block.sourceUrl} target="_blank" rel="noreferrer">打开原始来源</a></p>; break;
    case "divider": body = <hr />; break;
    default: { const exhaustive: never = block; return exhaustive; }
  }
  return <div className="history-block">{body}{block.provenance.length === 0 ? null : <details><summary>查看来源</summary>{block.provenance.map((source, index) => <p className="muted small" key={index}>{sourceLabel(source)}</p>)}</details>}</div>;
}

function sourceLabel(source: Provenance): string {
  switch (source.kind) {
    case "source": return `来源版本 ${source.sourceVersionId} · ${JSON.stringify(source.locator)}`;
    case "fact": return `事实版本 ${source.factVersionId}`;
    case "user_assertion": return `用户陈述 ${source.messageId}`;
  }
}

function HistoryMedia({ block, assetId }: { block: Extract<Block, { type: "image" | "video" }>; assetId: string | null }) {
  const asset = useQuery({ ...assetDetailQuery(assetId ?? ""), enabled: assetId !== null });
  const media = asset.data?.summary;
  const preview = block.type === "video" ? media?.posterFileUrl : media?.previewFileUrl ?? media?.originalFileUrl;
  return <figure className="history-media">
    {preview ? <img src={preview} alt={block.type === "image" ? block.alt : block.caption} loading="lazy" /> : <p>{asset.isLoading ? "正在读取历史素材" : "历史素材预览不可用"}</p>}
    <figcaption>{block.caption}</figcaption>
    <p className="muted small">素材版本 {block.assetVersionId}</p>
    {media?.originalFileUrl ? <a href={media.originalFileUrl} target="_blank" rel="noreferrer">查看原素材</a> : null}
  </figure>;
}
