import { useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ContentKind,
  Health,
  NarrativeId,
  TemplateSummary,
} from "@dmall/contracts";
import { createTemplate, templateListQuery } from "./api.js";
import { Dialog, ErrorLine, Icon, LoadingLine } from "../../ui.js";
import {
  InspectorFacts,
  InspectorPanel,
  InspectorSection,
  InspectorShell,
  useInspector,
} from "../../inspector.js";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inspector = useInspector("templates");
  const filters = {
    ...(q.trim() === "" ? {} : { q: q.trim() }),
    ...(kind === "all" ? {} : { kind }),
    ...(status === "all" ? {} : { status }),
  };
  const templates = useQuery(templateListQuery(filters));
  const items = useMemo(() => templates.data?.items ?? [], [templates.data]);
  const selected = items.find((template) => template.id === selectedId) ?? null;
  const filtered = q.trim() !== "" || kind !== "all" || status !== "all";
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

  useEffect(() => {
    if (selectedId !== null && !items.some((template) => template.id === selectedId)) setSelectedId(null);
  }, [items, selectedId]);

  useEffect(() => {
    if (inspector.narrow || inspector.preference !== "expanded" || selectedId !== null) return;
    const first = items[0];
    if (first !== undefined) setSelectedId(first.id);
  }, [items, inspector.narrow, inspector.preference, selectedId]);

  const select = (id: string) => {
    setSelectedId(id);
    if (inspector.narrow) inspector.open();
  };
  const revealInspector = () => {
    if (inspector.expanded) {
      inspector.close();
      return;
    }
    if (selectedId === null && items[0] !== undefined) setSelectedId(items[0].id);
    inspector.open();
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>模板库</h1>
          <span className="page-summary">
            {templates.data?.total ?? 0} 个模板 · 六种叙事，文档与演示共用一套结构
          </span>
        </div>
        <div className="page-actions">
          <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" />
            建立模板草稿
          </button>
        </div>
      </header>

      <div className="toolbar" aria-label="模板筛选">
        <label className="search-box">
          <Icon name="search" />
          <span className="sr-only">搜索模板名称</span>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="搜索模板名称"
            aria-label="搜索模板名称"
            type="search"
            autoComplete="off"
          />
        </label>
        <label className="select-wrap">
          <span>格式</span>
          <select value={kind} onChange={(event) => setKind(parseKindFilter(event.target.value))} aria-label="模板格式">
            <option value="all">全部格式</option>
            <option value="feishu_doc">飞书文档</option>
            <option value="html_deck">HTML 演示</option>
          </select>
        </label>
        <label className="select-wrap">
          <span>状态</span>
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
        </label>
      </div>

      <div className="result-bar">
        <span>
          <strong>{templates.data?.total ?? 0} 个模板</strong>
          {templates.data?.nextCursor == null ? null : <span className="result-note"> · 当前显示 {items.length} 个，可搜索其他模板</span>}
          {filtered ? <span className="result-note"> · 已筛选</span> : null}
        </span>
        <div className="result-actions">
          <span className="result-note">按最近更新</span>
          <button
            className="button small inspector-toggle"
            type="button"
            aria-expanded={inspector.expanded}
            aria-controls="template-inspector"
            onClick={revealInspector}
          >
            {inspector.expanded ? "收起详情" : "展开详情"}
          </button>
        </div>
      </div>

      <div className={`layout${inspector.expanded ? "" : " collapsed"}`}>
        <div className="library-list">
          {templates.isLoading ? <LoadingLine label="正在读取模板库" /> : null}
          {templates.isError ? <ErrorLine message={templates.error.message} /> : null}
          {templates.isSuccess && items.length === 0 ? (
            <section className="empty-panel template-empty">
              <span className="empty-icon" aria-hidden="true">▤</span>
              <h2>{filtered ? "没有符合条件的模板" : "模板库还没有内容"}</h2>
              <p>
                {filtered
                  ? "调整格式、状态或搜索词后再试。"
                  : "先选择一种叙事和输出格式，建立可编辑的本地草稿。验证不会由页面伪造。"}
              </p>
              {filtered ? null : (
                <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>建立第一份模板草稿</button>
              )}
            </section>
          ) : null}
          {items.length > 0 ? (
            <div className="library-grid" aria-label="模板列表">
              {items.map((template) => (
                <TemplateCard
                  template={template}
                  selected={selectedId === template.id}
                  key={template.id}
                  onSelect={() => select(template.id)}
                />
              ))}
            </div>
          ) : null}
        </div>

        <InspectorShell
          open={inspector.expanded}
          narrow={inspector.narrow}
          label="模板详情"
          onClose={inspector.close}
        >
          <InspectorPanel
            id="template-inspector"
            label="模板检查器"
            meta={selected === null ? "未选择" : `v${selected.currentVersion ?? 1} · ${kindLabel(selected.kind)}`}
            title={selected?.name}
            subtitle={selected?.narrativeName}
            preview={<div className="inspector-art"><Icon name={selected?.kind === "html_deck" ? "slide" : "template"} /></div>}
            closeLabel="关闭模板详情"
            onClose={inspector.close}
            emptyTitle="没有可查看的模板"
            emptyCopy="选择一份模板后，这里显示版本状态与编辑入口。"
            actions={selected === null ? undefined : (
              <>
                <button className="button primary" type="button" onClick={() => navigate(`/templates/${selected.id}`)}>
                  打开模板编辑
                </button>
                <button className="button secondary" type="button" onClick={() => setCreateOpen(true)}>
                  建立草稿
                </button>
              </>
            )}
          >
            {selected === null ? null : (
              <>
                <InspectorSection title="版本状态">
                  <InspectorFacts
                    rows={[
                      { label: "状态", value: templateStatusLabel(selected.status, selected.validationStatus) },
                      { label: "输出格式", value: kindLabel(selected.kind) },
                      { label: "当前版本", value: `v${selected.currentVersion ?? 1}` },
                      { label: "验证", value: validationLabel(selected.validationStatus) },
                      { label: "创建", value: formatDate(selected.createdAt) },
                      { label: "最近更新", value: formatDate(selected.updatedAt) },
                    ]}
                  />
                </InspectorSection>
                <InspectorSection title="叙事结构">
                  <p className="section-note">{selected.narrativeSummary}</p>
                </InspectorSection>
              </>
            )}
          </InspectorPanel>
        </InspectorShell>
      </div>

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

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: TemplateSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`file-card template-card${selected ? " selected" : ""}`}
      type="button"
      aria-pressed={selected}
      aria-label={`查看模板 ${template.name} 详情`}
      onClick={onSelect}
    >
      <div className="file-card-head">
        <span className="file-icon" aria-hidden="true">
          <Icon name={template.kind === "html_deck" ? "slide" : "doc"} />
        </span>
        <span className="file-card-heading">
          <span className="card-title">{template.name}</span>
          <span className="muted small">{template.narrativeName}</span>
        </span>
        <span className={`state-pill ${template.status}`}>{templateStatusLabel(template.status, template.validationStatus)}</span>
      </div>
      <p className="card-copy">{template.narrativeSummary}</p>
      <div className="card-footer">
        <span>v{template.currentVersion ?? 1} · {kindLabel(template.kind)}</span>
        <span>{validationLabel(template.validationStatus)}</span>
      </div>
    </button>
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

function validationLabel(status: TemplateSummary["validationStatus"]): string {
  if (status === "passed") return "验证通过";
  if (status === "failed") return "验证失败";
  if (status === "queued" || status === "running") return "验证中";
  return "未验证";
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function parseKindFilter(value: string): "all" | ContentKind {
  return value === "feishu_doc" || value === "html_deck" ? value : "all";
}

function parseStatusFilter(value: string): "all" | "draft" | "ready" | "archived" {
  return value === "draft" || value === "ready" || value === "archived" ? value : "all";
}
