import { useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ContentKind,
  Health,
  NarrativeId,
  TemplateSummary,
} from "@dmall/contracts";
import { createTemplate, templateListQuery } from "./api.js";
import { Dialog, ErrorLine, LoadingLine } from "../../ui.js";

interface Context {
  health: Health | undefined;
}

const NARRATIVES: ReadonlyArray<{
  id: NarrativeId;
  name: string;
  scene: string;
  beats: string[];
}> = [
  { id: "product-intro", name: "客户产品介绍", scene: "问题、定位、场景、价值", beats: ["经营问题", "产品定位", "场景演示", "价值与边界", "下一步"] },
  { id: "executive-progress", name: "管理层进展汇报", scene: "结论、证据、风险、计划", beats: ["本期结论", "价值证据", "客户案例", "风险", "下期计划"] },
  { id: "phase-review", name: "阶段成果复盘", scene: "目标、交付、采用、差距", beats: ["目标", "交付", "采用", "证据", "差距", "行动"] },
  { id: "merchant-solution", name: "商家解决方案", scene: "现状、目标、方案、验收", beats: ["商家现状", "场景目标", "方案", "演示", "验收"] },
  { id: "internal-sharing", name: "内部分享", scene: "问题、机制、实例、讨论", beats: ["问题", "机制", "实例", "经验", "讨论"] },
  { id: "training", name: "用户培训", scene: "入口、提问、任务、练习", beats: ["入口", "基础提问", "连续任务", "注意事项", "练习"] },
];

export function TemplateLibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { health } = useOutletContext<Context>();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | ContentKind>("all");
  const [status, setStatus] = useState<"all" | "draft" | "ready" | "archived">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const filters = {
    ...(q.trim() === "" ? {} : { q: q.trim() }),
    ...(kind === "all" ? {} : { kind }),
    ...(status === "all" ? {} : { status }),
  };
  const templates = useQuery(templateListQuery(filters));
  const create = useMutation({
    mutationFn: async (input: {
      name: string;
      kind: ContentKind;
      narrativeId: NarrativeId;
    }) => {
      if (health === undefined) throw new Error("本地会话尚未就绪");
      return createTemplate({ ...input, csrfToken: health.csrfToken });
    },
    onSuccess: async (detail) => {
      await queryClient.invalidateQueries({ queryKey: ["templates"] });
      setCreateOpen(false);
      navigate(`/templates/${detail.summary.id}`);
    },
  });

  return (
    <div className="page template-page">
      <header className="page-header template-page-header">
        <div>
          <span className="eyebrow">模板库 · T05</span>
          <h1>让结构先站稳</h1>
          <p>六种叙事、八种演示版式。草稿只有经过当前 Chromium 与 PDF 验证，才会成为已就绪版本。</p>
        </div>
        <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>
          ＋ 建立模板草稿
        </button>
      </header>

      <section className="template-toolbar" aria-label="模板筛选">
        <label className="template-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索模板名称"
            aria-label="搜索模板名称"
          />
        </label>
        <select value={kind} onChange={(event) => setKind(parseKindFilter(event.target.value))} aria-label="模板格式">
          <option value="all">全部格式</option>
          <option value="feishu_doc">飞书文档</option>
          <option value="html_deck">HTML 演示</option>
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(parseStatusFilter(event.target.value))}
          aria-label="模板状态"
        >
          <option value="all">全部状态</option>
          <option value="draft">草稿</option>
          <option value="ready">已就绪</option>
          <option value="archived">已归档</option>
        </select>
        <span className="template-count">{templates.data?.total ?? 0} 个模板</span>
      </section>

      <section className="narrative-gallery" aria-label="六种叙事预览">
        <div className="narrative-gallery-head">
          <span className="eyebrow">叙事样张</span>
          <p>同一个内容结构同时映射为飞书文档和 HTML 演示。</p>
        </div>
        <div className="narrative-gallery-track">
          {NARRATIVES.map((narrative, index) => (
            <article className={`narrative-mini narrative-${narrative.id}`} key={narrative.id}>
              <span className="narrative-mini-index">{String(index + 1).padStart(2, "0")}</span>
              <b>{narrative.name}</b>
              <div>
                {narrative.beats.slice(0, 4).map((beat) => <i key={beat}>{beat}</i>)}
              </div>
              <small>{narrative.scene}</small>
            </article>
          ))}
        </div>
      </section>

      {templates.isLoading ? <section className="panel"><LoadingLine label="正在读取模板库" /></section> : null}
      {templates.isError ? <section className="panel"><ErrorLine message={templates.error.message} /></section> : null}
      {templates.data?.items.length === 0 ? (
        <section className="empty-panel template-empty">
          <span className="empty-icon" aria-hidden="true">▤</span>
          <h2>{q === "" && kind === "all" && status === "all" ? "模板库还没有内容" : "没有符合条件的模板"}</h2>
          <p>
            {q === "" && kind === "all" && status === "all"
              ? "先选择一种叙事和输出格式，建立可编辑的本地草稿。验证不会由页面伪造。"
              : "调整格式、状态或搜索词后再试。"}
          </p>
          {q === "" && kind === "all" && status === "all" ? (
            <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>建立第一份模板草稿</button>
          ) : null}
        </section>
      ) : null}
      {templates.data !== undefined && templates.data.items.length > 0 ? (
        <section className="template-grid" aria-label="模板列表">
          {templates.data.items.map((template) => (
            <TemplateCard template={template} key={template.id} />
          ))}
        </section>
      ) : null}

      {createOpen ? (
        <CreateTemplateDialog
          busy={create.isPending}
          error={create.error instanceof Error ? create.error.message : null}
          onClose={() => setCreateOpen(false)}
          onCreate={(input) => create.mutate(input)}
        />
      ) : null}
    </div>
  );
}

function TemplateCard({ template }: { template: TemplateSummary }) {
  return (
    <Link className={`template-card narrative-${template.narrativeId}`} to={`/templates/${template.id}`}>
      <div className="template-preview" aria-hidden="true">
        <span className="template-preview-index">{String(template.currentVersion ?? 1).padStart(2, "0")}</span>
        <span className="template-preview-title">{template.narrativeName.slice(0, 8)}</span>
        <span className="template-preview-rule" />
        <span className="template-preview-rule short" />
        <span className="template-preview-orbit" />
      </div>
      <div className="template-card-body">
        <div className="card-topline">
          <span className={`state-pill ${template.status}`}>{templateStatusLabel(template.status, template.validationStatus)}</span>
          <span className="kind-pill">{kindLabel(template.kind)}</span>
        </div>
        <h2>{template.name}</h2>
        <p>{template.narrativeSummary}</p>
        <div className="template-card-foot">
          <span>v{template.currentVersion ?? 1} · {template.narrativeName}</span>
          <span>打开 →</span>
        </div>
      </div>
    </Link>
  );
}

function CreateTemplateDialog({
  busy,
  error,
  onClose,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: { name: string; kind: ContentKind; narrativeId: NarrativeId }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ContentKind>("feishu_doc");
  const [narrativeId, setNarrativeId] = useState<NarrativeId>("product-intro");
  const narrative = NARRATIVES.find((item) => item.id === narrativeId);
  return (
    <Dialog
      title="建立模板草稿"
      subtitle="草稿会保存在本机。显示名可以之后通过新版本修改，已就绪版本不会被原地覆盖。"
      onClose={onClose}
      wide
    >
      <form
        className="dialog-form template-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "" || busy) return;
          onCreate({ name: name.trim(), kind, narrativeId });
        }}
      >
        <label className="field">
          <span>模板名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={narrative === undefined ? "例如：产品介绍文档模板" : `${narrative.name}模板`}
            maxLength={200}
            data-autofocus
          />
        </label>
        <fieldset className="template-choice-field">
          <legend>输出格式</legend>
          <div className="seg">
            <button type="button" className={kind === "feishu_doc" ? "on" : ""} onClick={() => setKind("feishu_doc")}>飞书文档</button>
            <button type="button" className={kind === "html_deck" ? "on" : ""} onClick={() => setKind("html_deck")}>HTML 演示</button>
          </div>
        </fieldset>
        <fieldset className="template-choice-field">
          <legend>叙事结构</legend>
          <div className="narrative-choice-grid">
            {NARRATIVES.map((item) => (
              <label className={`narrative-choice${narrativeId === item.id ? " selected" : ""}`} key={item.id}>
                <input
                  type="radio"
                  name="narrative"
                  value={item.id}
                  checked={narrativeId === item.id}
                  onChange={() => setNarrativeId(item.id)}
                />
                <span><b>{item.name}</b><small>{item.scene}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
        {error === null ? null : <ErrorLine message={error} />}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>取消</button>
          <button className="button primary" type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "正在建立…" : "建立草稿"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function kindLabel(kind: ContentKind): string {
  return kind === "feishu_doc" ? "飞书文档" : "HTML 演示";
}

function templateStatusLabel(
  status: TemplateSummary["status"],
  validation: TemplateSummary["validationStatus"],
): string {
  if (status === "archived") return "已归档";
  if (status === "ready") return "已就绪";
  if (validation === "failed") return "验证失败";
  if (validation === "queued" || validation === "running") return "验证中";
  return "草稿";
}

function parseKindFilter(value: string): "all" | ContentKind {
  return value === "feishu_doc" || value === "html_deck" ? value : "all";
}

function parseStatusFilter(value: string): "all" | "draft" | "ready" | "archived" {
  return value === "draft" || value === "ready" || value === "archived" ? value : "all";
}
