import { type ReactNode } from "react";
import { Link, useOutletContext } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ContentKind, Health } from "@dmall/contracts";
import {
  contentsQuery,
} from "./api.js";
import { ErrorLine, LoadingLine } from "./ui.js";
import { AssetLibraryPage } from "./features/assets/AssetLibraryPage.js";

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
        description="说出想法，调整方案，确认后由 AI 完成写作与交付。"
        action={<button className="button primary" type="button" onClick={openNew}>＋ 新建内容</button>}
      />
      <section className="hero-card">
        <div>
          <span className="eyebrow">本机工作台</span>
          <h2>{contents.data?.total === 0 ? "还没有一份内容" : "继续最近的创作"}</h2>
          <p>
            输入用途和受众，先查看真实模板与素材推荐。确认后可离开页面，后台继续完成。
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
          copy="开始一次 AI 创作。旧内容和历史成品仍会保留。"
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
