import { useEffect, useState, type ReactNode } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContentDetail, ContentKind, Health } from "@dmall/contracts";
import {
  contentQuery,
  contentsQuery,
  updateContent,
} from "./api.js";
import { ErrorLine, LoadingLine } from "./ui.js";
import { AssetLibraryPage } from "./features/assets/AssetLibraryPage.js";
import { OutputActions } from "./features/outputs/OutputActions.js";

interface OutletContext {
  openNew: () => void;
  health: Health | undefined;
}

export function ContentsPage() {
  const { openNew } = useOutletContext<OutletContext>();
  const contents = useQuery(contentsQuery);
  return (
    <div className="page">
      <PageHeader
        eyebrow="内容库"
        title="把想法送到交付"
        description="每份内容从一个清楚的标题开始，再逐步加入章节、素材与版本。"
        action={<button className="button primary" type="button" onClick={openNew}>＋ 新建内容</button>}
      />
      <section className="hero-card">
        <div>
          <span className="eyebrow">本机工作台</span>
          <h2>{contents.data?.total === 0 ? "还没有一份内容" : "继续最近的创作"}</h2>
          <p>
            没有配置模型也不会拦住第一步。空白稿会保存在本机，关闭浏览器再打开仍可继续。
          </p>
          <div className="hero-meta">
            <span className="soft-pill">内容 {contents.data?.total ?? 0}</span>
            <span className="soft-pill">文档与演示分开管理</span>
            <span className="soft-pill">本机保存</span>
          </div>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <strong>{contents.data?.total ?? 0}</strong>
          <span>份内容</span>
        </div>
      </section>
      {contents.isLoading ? <Panel><LoadingLine label="正在读取内容库" /></Panel> : null}
      {contents.isError ? <Panel><ErrorLine message={contents.error.message} /></Panel> : null}
      {contents.data !== undefined && contents.data.items.length === 0 ? (
        <EmptyPanel
          icon="◇"
          title="内容列表为空"
          copy="这里不会出现示例卡片。先建立一份空白内容，之后再配置素材和模型。"
          action={<button className="button primary" type="button" onClick={openNew}>＋ 建立第一份内容</button>}
        />
      ) : null}
      {contents.data !== undefined && contents.data.items.length > 0 ? (
        <section className="content-grid" aria-label="内容列表">
          {contents.data.items.map((item) => (
            <Link className="content-card" to={`/contents/${item.id}`} key={item.id}>
              <div className="card-topline">
                <span className={`state-pill ${item.status}`}>{statusLabel(item.status)}</span>
                <span className="muted small">{formatDate(item.updatedAt)}</span>
              </div>
              <h3>{item.title}</h3>
              <div className="format-row">
                {item.kinds.map((kind) => <span className="kind-pill" key={kind}>{kindLabel(kind)}</span>)}
              </div>
              <div className="card-footer">
                <span>版本 {item.version + 1}</span>
                <span>打开详情 →</span>
              </div>
            </Link>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function ContentDetailPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { health } = useOutletContext<OutletContext>();
  const detail = useQuery(contentQuery(id ?? ""));
  const [title, setTitle] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (detail.data !== undefined) setTitle(detail.data.title);
  }, [detail.data]);

  const save = useMutation({
    mutationFn: async (current: ContentDetail) => {
      if (health === undefined) throw new Error("本地会话尚未就绪");
      return updateContent({
        id: current.id,
        title: title.trim(),
        expectedVersion: current.version,
        csrfToken: health.csrfToken,
      });
    },
    onSuccess: async (next) => {
      setSaved(true);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["content", next.id] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
    },
    onError: (reason) => {
      setSaved(false);
      setError(reason instanceof Error ? reason.message : "保存失败");
    },
  });

  if (id === undefined) return <Panel><ErrorLine message="内容地址不完整" /></Panel>;
  if (detail.isLoading) return <Panel><LoadingLine label="正在打开内容" /></Panel>;
  if (detail.isError) return <Panel><ErrorLine message={detail.error.message} /></Panel>;
  if (detail.data === undefined) return null;
  const content = detail.data;

  return (
    <div className="page detail-page">
      <div className="breadcrumb"><Link to="/contents">内容库</Link><span>/</span><span>{content.title}</span></div>
      <div className="detail-heading">
        <div>
          <span className="eyebrow">基础详情</span>
          <h1>{content.title}</h1>
          <div className="hero-meta">
            <span className="state-pill draft">{statusLabel(content.status)}</span>
            <span className="soft-pill">版本 {content.version + 1}</span>
            <span className="soft-pill">{kindLabel(content.kinds[0] ?? "feishu_doc")}</span>
          </div>
        </div>
        <Link className="button secondary" to="/contents">返回内容库</Link>
      </div>
      <div className="detail-grid">
        <section className="panel detail-main">
          <div className="panel-title-row">
            <div><span className="eyebrow">内容标题</span><h2>先把名字改对</h2></div>
            <span className="soft-pill">可手动编辑</span>
          </div>
          <form
            className="title-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim() === "" || save.isPending) return;
              setSaved(false);
              save.mutate(content);
            }}
          >
            <label className="field">
              <span className="sr-only">内容标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
            </label>
            <button className="button primary" type="submit" disabled={save.isPending || title.trim() === "" || title.trim() === content.title}>
              {save.isPending ? "保存中…" : "保存标题"}
            </button>
          </form>
          {saved ? <div className="inline-success" role="status">标题已保存到本机。</div> : null}
          {error === null ? null : <ErrorLine message={error} />}
          <div className="editor-placeholder">
            <span className="placeholder-mark">◌</span>
            <div>
              <h3>完整编辑尚未开放</h3>
              <p>当前提供基础详情和标题修改。章节、正文、素材引用和版本对比会在编辑阶段接入。</p>
            </div>
          </div>
          <div className="info-block">
            <span className="eyebrow">需求摘要</span>
            <p>{content.brief.goal === "" ? "尚未填写目标。可在后续编辑阶段补充。" : content.brief.goal}</p>
          </div>
        </section>
        <aside className="panel detail-side">
          <span className="eyebrow">这次创作</span>
          <h2>真实状态</h2>
          <dl className="detail-list">
            <div><dt>格式</dt><dd>{content.kinds.map(kindLabel).join("、")}</dd></div>
            <div><dt>版本</dt><dd>当前第 {content.version + 1} 版</dd></div>
            <div><dt>创建时间</dt><dd>{formatDate(content.createdAt)}</dd></div>
            <div><dt>最后更新</dt><dd>{formatDate(content.updatedAt)}</dd></div>
            <div><dt>会话</dt><dd>{content.conversations.length} 个</dd></div>
          </dl>
          <div className="drawer-note">
            AI 生成与语音转写需要先配置并验证对应能力。未配置时不会显示生成成功。
          </div>
          {health?.csrfToken === undefined ? null : (
            <OutputActions
              contentId={content.id}
              title={content.title}
              renditions={content.renditions}
              csrfToken={health.csrfToken}
              compact
            />
          )}
        </aside>
      </div>
    </div>
  );
}

export function AssetsPage() {
  return <AssetLibraryPage />;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action: ReactNode }) {
  return (
    <div className="page-header">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      <div>{action}</div>
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <section className="panel">{children}</section>;
}

function EmptyPanel({ icon, title, copy, action }: { icon: string; title: string; copy: string; action: ReactNode }) {
  return (
    <section className="empty-panel">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
      <div>{action}</div>
    </section>
  );
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
