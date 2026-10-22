import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DeckLayout,
  Health,
  JobSnapshot,
  LayoutDefinition,
  TemplateDetail,
  TemplatePackage,
  TemplateSlot,
  TemplateValidationResult,
} from "@dmall/contracts";
import {
  archiveTemplateVersion,
  createTemplateVersion,
  getJob,
  templateDetailQuery,
  validateTemplateVersion,
} from "./api.js";
import { ErrorLine, LoadingLine } from "../../ui.js";

interface Context {
  health: Health | undefined;
}

type EditorTab = "structure" | "slots" | "theme";

export function TemplateDetailPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { health } = useOutletContext<Context>();
  const versionId = searchParams.get("versionId") ?? undefined;
  const detail = useQuery(templateDetailQuery(id ?? "", versionId));
  const [draft, setDraft] = useState<TemplatePackage | null>(null);
  const [tab, setTab] = useState<EditorTab>("structure");
  const [changeSummary, setChangeSummary] = useState("调整模板结构");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobVersionId, setJobVersionId] = useState<string | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadedVersionId = useRef<string | null>(null);

  useEffect(() => {
    if (detail.data === undefined) return;
    const versionChanged = loadedVersionId.current !== detail.data.version.id;
    if (versionChanged) {
      loadedVersionId.current = detail.data.version.id;
      setDraft(structuredClone(detail.data.version.package));
      setChangeSummary(`调整 ${detail.data.summary.name} 模板`);
      setJob(null);
      setActionError(null);
    }
    const validation = detail.data.version.validation;
    if (validation !== null && (validation.status === "queued" || validation.status === "running")) {
      setJob((current) => current?.id === validation.jobId ? current : null);
      setJobId(validation.jobId);
      setJobVersionId(detail.data.version.id);
    } else if (versionChanged) {
      setJobId(null);
      setJobVersionId(null);
    }
  }, [detail.data]);

  useEffect(() => {
    if (jobId === null || jobVersionId !== detail.data?.version.id) return;
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await getJob(jobId);
        if (!active) return;
        setJob(next);
        if (["succeeded", "failed", "cancelled", "partial"].includes(next.state)) {
          await queryClient.invalidateQueries({ queryKey: ["template", id ?? ""] });
          await queryClient.invalidateQueries({ queryKey: ["templates"] });
          return;
        }
      } catch (reason) {
        if (active) setActionError(reason instanceof Error ? reason.message : "读取验证任务失败");
      }
      if (active) timer = window.setTimeout(poll, 900);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [id, jobId, jobVersionId, detail.data?.version.id, queryClient]);

  const save = useMutation({
    mutationFn: async () => {
      if (health === undefined || draft === null || detail.data === undefined) {
        throw new Error("本地模板尚未就绪");
      }
      return createTemplateVersion({
        templateId: detail.data.summary.id,
        baseVersionId: detail.data.version.id,
        packageValue: draft,
        changeSummary,
        csrfToken: health.csrfToken,
      });
    },
    onSuccess: async (next) => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["template", next.summary.id] });
      await queryClient.invalidateQueries({ queryKey: ["templates"] });
      setSearchParams({ versionId: next.version.id });
    },
    onError: (reason) => setActionError(reason instanceof Error ? reason.message : "保存新版本失败"),
  });

  const validate = useMutation({
    mutationFn: async () => {
      if (health === undefined || detail.data === undefined) throw new Error("本地模板尚未就绪");
      return validateTemplateVersion({
        templateId: detail.data.summary.id,
        versionId: detail.data.version.id,
        csrfToken: health.csrfToken,
      });
    },
    onSuccess: async (started) => {
      if (loadedVersionId.current !== started.versionId) return;
      setActionError(null);
      setJob(null);
      setJobId(started.jobId);
      setJobVersionId(started.versionId);
      await queryClient.invalidateQueries({ queryKey: ["template", id ?? ""] });
    },
    onError: (reason) => setActionError(reason instanceof Error ? reason.message : "启动验证失败"),
  });

  const archive = useMutation({
    mutationFn: async () => {
      if (health === undefined || detail.data === undefined) throw new Error("本地模板尚未就绪");
      if (detail.data.version.status === "archived") throw new Error("版本已归档");
      return archiveTemplateVersion({
        templateId: detail.data.summary.id,
        versionId: detail.data.version.id,
        expectedStatus: detail.data.version.status,
        csrfToken: health.csrfToken,
      });
    },
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["template", id ?? ""] });
      await queryClient.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (reason) => setActionError(reason instanceof Error ? reason.message : "归档失败"),
  });

  const dirty = useMemo(() => {
    if (detail.data === undefined || draft === null) return false;
    return JSON.stringify(draft) !== JSON.stringify(detail.data.version.package);
  }, [detail.data, draft]);

  if (id === undefined) return <section className="panel"><ErrorLine message="模板地址不完整" /></section>;
  if (detail.isLoading) return <section className="panel"><LoadingLine label="正在打开模板" /></section>;
  if (detail.isError) return <section className="panel"><ErrorLine message={detail.error.message} /></section>;
  if (detail.data === undefined || draft === null) return null;

  const data = detail.data;
  const currentJob = jobVersionId === data.version.id ? job : null;
  const report = validationReport(data, currentJob);
  const busyValidation =
    data.version.validation?.status === "queued" || data.version.validation?.status === "running" ||
    (jobVersionId === data.version.id &&
    jobId !== null &&
    (currentJob === null || currentJob.state === "queued" || currentJob.state === "running"));
  const canValidate = data.version.status === "draft" && !dirty && !busyValidation;

  return (
    <div className="page template-detail-page">
      <div className="breadcrumb"><Link to="/templates">模板库</Link><span>/</span><span>{data.summary.name}</span></div>
      <header className="template-detail-head">
        <div>
          <span className="eyebrow">{data.summary.narrativeName} · {kindLabel(data.summary.kind)}</span>
          <h1>{data.summary.name}</h1>
          <div className="hero-meta">
            <span className={`state-pill ${data.version.status}`}>{versionStatusLabel(data)}</span>
            <span className="soft-pill">v{data.version.version}</span>
            <span className="soft-pill">{data.summary.narrativeId}</span>
            <span className="soft-pill">{data.version.package.slots.length} 个槽位</span>
          </div>
        </div>
        <div className="template-head-actions">
          <label className="version-select">
            <span>查看版本</span>
            <select
              value={data.version.id}
              onChange={(event) => setSearchParams({ versionId: event.target.value })}
            >
              {data.versions.map((version) => (
                <option value={version.id} key={version.id}>
                  v{version.version} · {version.status === "ready" ? "已就绪" : version.status === "archived" ? "已归档" : "草稿"}
                </option>
              ))}
            </select>
          </label>
          <Link className="button secondary" to="/templates">返回列表</Link>
        </div>
      </header>

      <div className="template-workbench">
        <section className="template-main-column">
          <TemplatePreview detail={data} draft={draft} />
          <section className="panel template-editor-panel">
            <div className="panel-title-row">
              <div>
                <span className="eyebrow">受控编辑</span>
                <h2>保存时建立新版本</h2>
              </div>
              <div className="seg compact" aria-label="编辑范围">
                <button type="button" className={tab === "structure" ? "on" : ""} onClick={() => setTab("structure")}>结构</button>
                <button type="button" className={tab === "slots" ? "on" : ""} onClick={() => setTab("slots")}>槽位</button>
                <button type="button" className={tab === "theme" ? "on" : ""} onClick={() => setTab("theme")}>主题</button>
              </div>
            </div>
            {tab === "structure" ? <StructureEditor draft={draft} onChange={setDraft} /> : null}
            {tab === "slots" ? <SlotsEditor draft={draft} onChange={setDraft} /> : null}
            {tab === "theme" ? <ThemeEditor draft={draft} onChange={setDraft} /> : null}
            <div className="template-save-row">
              <label className="field template-summary-field">
                <span>版本说明</span>
                <input
                  value={changeSummary}
                  onChange={(event) => setChangeSummary(event.target.value)}
                  maxLength={500}
                  placeholder="说明这次结构、槽位或主题的改动"
                />
              </label>
              <button
                className="button primary"
                type="button"
                disabled={!dirty || changeSummary.trim() === "" || save.isPending || data.version.status === "archived"}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "正在保存…" : dirty ? "保存为新版本" : "没有未保存改动"}
              </button>
            </div>
          </section>

          <ValidationPanel
            data={data}
            report={report}
            job={currentJob}
            busy={busyValidation || validate.isPending}
            disabled={!canValidate}
            disabledReason={
              data.version.status !== "draft"
                ? "只有草稿版本可以启动验证"
                : dirty
                  ? "请先保存当前编辑，再验证固定版本"
                  : undefined
            }
            onValidate={() => validate.mutate()}
          />
        </section>

        <aside className="template-side-column">
          <section className="panel template-status-card">
            <span className="eyebrow">版本状态</span>
            <h2>{versionStatusLabel(data)}</h2>
            <p>{versionStatusCopy(data)}</p>
            <dl className="detail-list">
              <div><dt>版本</dt><dd>v{data.version.version}</dd></div>
              <div><dt>模板 hash</dt><dd className="hash-value">{data.version.packageHash.slice(0, 16)}…</dd></div>
              <div><dt>渲染器</dt><dd>{data.version.package.rendererVersion}</dd></div>
              <div><dt>更新</dt><dd>{formatDate(data.summary.updatedAt)}</dd></div>
            </dl>
            {data.version.validation === null ? null : (
              <div className="validation-status-line">
                <span>最近验证</span>
                <b className={`validation-status ${data.version.validation.status}`}>
                  {validationStatusLabel(data.version.validation.status)}
                </b>
              </div>
            )}
            {data.version.status !== "archived" ? (
              <button
                className="button danger small template-archive"
                type="button"
                disabled={archive.isPending}
                onClick={() => {
                  if (window.confirm(`归档 v${data.version.version}？历史版本仍可打开，但不能再创建后续版本。`)) {
                    archive.mutate();
                  }
                }}
              >
                {archive.isPending ? "正在归档…" : "归档当前版本"}
              </button>
            ) : null}
          </section>
          <section className="panel template-help-card">
            <span className="eyebrow">验证规则</span>
            <h2>页面不能代替证据</h2>
            <p>只有 worker 完成 Chromium 加载、屏幕与打印溢出检查、PDF 生成、资源与对比度检查，API 才会标记 ready。</p>
            <ul>
              <li>标题按实际 slide.layout 的容量检查，单位为 JS UTF-16 长度。</li>
              <li>ready 证据绑定整个模板包、AST 和 HTML 三份 hash。</li>
              <li>失败时版本保持草稿，报告保留具体路径与原因。</li>
            </ul>
          </section>
          {actionError === null ? null : <ErrorLine message={actionError} />}
        </aside>
      </div>
    </div>
  );
}

function TemplatePreview({ detail, draft }: { detail: TemplateDetail; draft: TemplatePackage }) {
  return (
    <section className="panel template-preview-panel">
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">六叙事预览</span>
          <h2>{draft.narrative.name}</h2>
          <p>{draft.narrative.summary}</p>
        </div>
        <span className="soft-pill">{draft.rendererVersion}</span>
      </div>
      {detail.version.kind === "feishu_doc" ? (
        <div className="doc-template-preview">
          <div className="doc-template-page">
            <span className="template-preview-kicker">{draft.narrative.name}</span>
            {draft.narrative.doc.sections.map((section, index) => (
              <div className="doc-template-section" key={section.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><b>{section.title}</b><small>{section.purpose}</small></div>
              </div>
            ))}
          </div>
          <div className="template-slot-summary">
            {draft.slots.slice(0, 8).map((slot) => (
              <span key={slot.id}><b>{slot.label}</b><small>{slot.blockType} · {capacityLabel(slot)}</small></span>
            ))}
          </div>
        </div>
      ) : (
        <div className="deck-template-strip">
          {draft.narrative.deck.slides.map((slide, index) => (
              <article className={`deck-mini layout-${slide.layout}`} key={slide.id}>
                <span className="deck-mini-index">{String(index + 1).padStart(2, "0")} · {slide.layout}</span>
                <strong>{slide.title}</strong>
                <p>{slide.purpose}</p>
                <i aria-hidden="true" />
              </article>
          ))}
        </div>
      )}
    </section>
  );
}

function StructureEditor({
  draft,
  onChange,
}: {
  draft: TemplatePackage;
  onChange: (value: TemplatePackage) => void;
}) {
  return (
    <div className="template-structure-editor">
      <div className="template-field-grid">
        <label className="field">
          <span>叙事名称</span>
          <input
            value={draft.narrative.name}
            onChange={(event) => onChange(patchDraft(draft, (value) => ({
              narrative: { ...value.narrative, name: event.target.value },
            })))}
          />
        </label>
        <label className="field">
          <span>叙事摘要</span>
          <input
            value={draft.narrative.summary}
            onChange={(event) => onChange(patchDraft(draft, (value) => ({
              narrative: { ...value.narrative, summary: event.target.value },
            })))}
          />
        </label>
      </div>
      {draft.manifest.kind === "feishu_doc" ? (
        <div className="structure-card-list">
          {draft.narrative.doc.sections.map((section, index) => (
            <article className="structure-edit-card" key={section.id}>
              <span className="structure-order">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <label className="field">
                  <span>章节标题</span>
                  <input
                    value={section.title}
                    onChange={(event) => onChange(updateDocSection(draft, index, { title: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>写作目的</span>
                  <textarea
                    value={section.purpose}
                    onChange={(event) => onChange(updateDocSection(draft, index, { purpose: event.target.value }))}
                    rows={2}
                  />
                </label>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="structure-card-list">
          {draft.narrative.deck.slides.map((slide, index) => (
            <article className="structure-edit-card" key={slide.id}>
              <span className="structure-order">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <div className="template-field-grid">
                  <label className="field">
                    <span>页面标题 · {slide.title.length}/{draft.layouts.find((layout) => layout.id === slide.layout)?.titleMaxCharacters ?? "?"}</span>
                    <input
                      value={slide.title}
                      onChange={(event) => onChange(updateDeckSlide(draft, index, { title: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>版式</span>
                    <select
                      value={slide.layout}
                      onChange={(event) => {
                        const layout = parseDeckLayout(event.target.value);
                        const target = draft.layouts.find((item) => item.id === layout);
                        if (target === undefined) return;
                        const slots = remapSlideSlots(draft, slide.id, target);
                        if (slots !== null) onChange({ ...updateDeckSlide(draft, index, { layout: target.id }), slots });
                      }}
                    >
                      {draft.layouts.map((layout) => {
                        const supported = remapSlideSlots(draft, slide.id, layout) !== null;
                        return (
                          <option value={layout.id} key={layout.id} disabled={!supported}>
                            {layout.name} · {layout.id}{supported ? "" : " · 无法保留当前槽位"}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>
                <label className="field">
                  <span>页面目的</span>
                  <textarea
                    value={slide.purpose}
                    onChange={(event) => onChange(updateDeckSlide(draft, index, { purpose: event.target.value }))}
                    rows={2}
                  />
                </label>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function SlotsEditor({
  draft,
  onChange,
}: {
  draft: TemplatePackage;
  onChange: (value: TemplatePackage) => void;
}) {
  return (
    <div className="slot-editor-list">
      {draft.slots.map((slot, index) => (
        <article className="slot-edit-row" key={slot.id}>
          <div className="slot-edit-id">
            <span>{slot.blockType}</span>
            <b>{slot.id}</b>
            <small>容器 {slot.containerId}</small>
          </div>
          <label className="field">
            <span>显示名</span>
            <input
              value={slot.label}
              onChange={(event) => onChange(updateSlot(draft, index, { label: event.target.value }))}
            />
          </label>
          <label className="slot-required">
            <input
              type="checkbox"
              checked={slot.required}
              onChange={(event) => onChange(updateSlot(draft, index, { required: event.target.checked }))}
            />
            必填
          </label>
          <div className="slot-capacity-fields">
            {slot.capacity.maxCharacters !== undefined ? (
              <label className="field compact-field">
                <span>字符</span>
                <input
                  type="number"
                  min={1}
                  value={slot.capacity.maxCharacters}
                  onChange={(event) => onChange(updateSlotCapacity(draft, index, "maxCharacters", event.target.value))}
                />
              </label>
            ) : null}
            {slot.capacity.maxItems !== undefined ? (
              <label className="field compact-field">
                <span>条目</span>
                <input
                  type="number"
                  min={1}
                  value={slot.capacity.maxItems}
                  onChange={(event) => onChange(updateSlotCapacity(draft, index, "maxItems", event.target.value))}
                />
              </label>
            ) : null}
            {slot.capacity.maxRows !== undefined ? (
              <label className="field compact-field">
                <span>行数</span>
                <input
                  type="number"
                  min={1}
                  value={slot.capacity.maxRows}
                  onChange={(event) => onChange(updateSlotCapacity(draft, index, "maxRows", event.target.value))}
                />
              </label>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function ThemeEditor({
  draft,
  onChange,
}: {
  draft: TemplatePackage;
  onChange: (value: TemplatePackage) => void;
}) {
  const paletteFields = [
    ["background", "背景"],
    ["surface", "卡片"],
    ["text", "正文"],
    ["muted", "辅助文字"],
    ["accent", "强调色"],
  ] as const;
  return (
    <div className="theme-editor">
      <div className="theme-palette-list">
        {paletteFields.map(([field, label]) => (
          <label className="theme-color-field" key={field}>
            <span>{label}</span>
            <input
              type="color"
              value={draft.theme.palette[field]}
              onChange={(event) => onChange(patchDraft(draft, (value) => ({
                theme: {
                  ...value.theme,
                  palette: { ...value.theme.palette, [field]: event.target.value },
                },
              })))}
            />
            <code>{draft.theme.palette[field]}</code>
          </label>
        ))}
      </div>
      <div className="template-field-grid">
        <label className="field">
          <span>面板圆角</span>
          <input
            type="number"
            min={16}
            max={32}
            value={draft.theme.radius.panel}
            onChange={(event) => onChange(patchDraft(draft, (value) => ({
              theme: {
                ...value.theme,
                radius: { ...value.theme.radius, panel: Number(event.target.value) },
              },
            })))}
          />
        </label>
        <label className="field">
          <span>卡片圆角</span>
          <input
            type="number"
            min={8}
            max={32}
            value={draft.theme.radius.card}
            onChange={(event) => onChange(patchDraft(draft, (value) => ({
              theme: {
                ...value.theme,
                radius: { ...value.theme.radius, card: Number(event.target.value) },
              },
            })))}
          />
        </label>
      </div>
      <div
        className="theme-preview-chip"
        style={{
          background: draft.theme.palette.background,
          color: draft.theme.palette.text,
          borderColor: draft.theme.palette.border,
          borderRadius: draft.theme.radius.card,
        }}
      >
        <b>{draft.narrative.name}</b>
        <span style={{ color: draft.theme.palette.muted }}>{draft.narrative.summary}</span>
        <i style={{ background: draft.theme.palette.accent }} />
      </div>
    </div>
  );
}

function ValidationPanel({
  data,
  report,
  job,
  busy,
  disabled,
  disabledReason,
  onValidate,
}: {
  data: TemplateDetail;
  report: TemplateValidationResult | null;
  job: JobSnapshot | null;
  busy: boolean;
  disabled: boolean;
  disabledReason: string | undefined;
  onValidate: () => void;
}) {
  return (
    <section className="panel validation-panel">
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">真实验证</span>
          <h2>Chromium 加载、打印与 PDF</h2>
          <p>验证任务在 worker 中运行。API 只接收带 fence 和双 hash 的终态结果。</p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={disabled || busy}
          onClick={onValidate}
          title={disabledReason}
        >
          {busy ? "验证进行中…" : "启动验证"}
        </button>
      </div>
      {disabledReason !== undefined ? <p className="section-note">{disabledReason}</p> : null}
      {job !== null ? (
        <div className={`job-strip ${job.state}`}>
          <span className={`status-dot ${job.state}`} />
          <div><b>{jobPhaseLabel(job.state)}</b><small>{job.error?.message ?? job.phase}</small></div>
          <code>{job.id.slice(0, 8)}</code>
        </div>
      ) : null}
      {report === null ? (
        <div className="validation-empty">
          <span>◌</span>
          <p>{data.version.validation === null ? "这个版本还没有验证报告。" : "报告正在生成或未返回检查项。"}</p>
        </div>
      ) : (
        <>
          <div className={`validation-decision ${report.ok ? "pass" : "blocked"}`}>
            <b>{report.ok ? "验证通过" : "验证未通过"}</b>
            <span>{report.issues.length === 0 ? "所有检查通过。" : `${report.issues.length} 个问题需要修正`}</span>
          </div>
          <div className="validation-check-grid">
            {report.checks.map((check) => (
              <div className={`validation-check ${check.ok ? "ok" : "bad"}`} key={check.id}>
                <span>{check.ok ? "✓" : "!"}</span>
                <div><b>{check.label}</b><small>{check.detail}</small></div>
              </div>
            ))}
          </div>
          {report.issues.length > 0 ? (
            <div className="validation-issues">
              <h3>可修正的问题</h3>
              {report.issues.map((issue, index) => (
                <div className="validation-issue" key={`${issue.code}-${issue.path}-${index}`}>
                  <code>{issue.code}</code>
                  <b>{issue.path}</b>
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function patchDraft(
  draft: TemplatePackage,
  update: (value: TemplatePackage) => Partial<TemplatePackage>,
): TemplatePackage {
  return { ...draft, ...update(draft) };
}

function updateDocSection(
  draft: TemplatePackage,
  index: number,
  patch: Partial<TemplatePackage["narrative"]["doc"]["sections"][number]>,
): TemplatePackage {
  return patchDraft(draft, (value) => ({
    narrative: {
      ...value.narrative,
      doc: {
        sections: value.narrative.doc.sections.map((section, position) =>
          position === index ? { ...section, ...patch } : section,
        ),
      },
    },
  }));
}

function updateDeckSlide(
  draft: TemplatePackage,
  index: number,
  patch: Partial<TemplatePackage["narrative"]["deck"]["slides"][number]>,
): TemplatePackage {
  return patchDraft(draft, (value) => ({
    narrative: {
      ...value.narrative,
      deck: {
        slides: value.narrative.deck.slides.map((slide, position) =>
          position === index ? { ...slide, ...patch } : slide,
        ),
      },
    },
  }));
}

function remapSlideSlots(
  draft: TemplatePackage,
  slideId: string,
  layout: LayoutDefinition,
): TemplateSlot[] | null {
  const available = [...layout.slots];
  const replacements = new Map<string, TemplateSlot>();
  for (const slot of draft.slots.filter((item) => item.containerId === slideId)) {
    const compatible = available.filter((target) =>
      target.blockTypes.includes(slot.blockType) ||
      (target.blockTypes.includes("list") && slot.source.kind === "default" && slot.source.value.kind === "text"),
    );
    const target = compatible.find((item) => item.id === slot.layoutSlotId) ??
      (compatible.length === 1 ? compatible[0] : undefined);
    if (target === undefined) return null;
    const toList = !target.blockTypes.includes(slot.blockType);
    const source = toList && slot.source.kind === "default" && slot.source.value.kind === "text"
      ? { kind: "default", value: { kind: "list", items: [slot.source.value.text] } } satisfies TemplateSlot["source"]
      : slot.source;
    replacements.set(slot.id, {
      ...slot,
      layoutSlotId: target.id,
      blockType: toList ? "list" : slot.blockType,
      required: slot.required || target.required,
      capacity: {
        ...slot.capacity,
        ...(target.maxCharacters === undefined ? {} : {
          maxCharacters: Math.min(slot.capacity.maxCharacters ?? target.maxCharacters, target.maxCharacters),
        }),
        ...(target.maxItems === undefined ? {} : {
          maxItems: Math.min(slot.capacity.maxItems ?? target.maxItems, target.maxItems),
        }),
        ...(target.maxRows === undefined ? {} : {
          maxRows: Math.min(slot.capacity.maxRows ?? target.maxRows, target.maxRows),
        }),
      },
      source,
    });
    available.splice(available.indexOf(target), 1);
  }
  if (available.some((slot) => slot.required)) return null;
  return draft.slots.map((slot) => replacements.get(slot.id) ?? slot);
}

function updateSlot(
  draft: TemplatePackage,
  index: number,
  patch: Partial<TemplateSlot>,
): TemplatePackage {
  return patchDraft(draft, (value) => ({
    slots: value.slots.map((slot, position) =>
      position === index ? { ...slot, ...patch } : slot,
    ),
  }));
}

function updateSlotCapacity(
  draft: TemplatePackage,
  index: number,
  field: "maxCharacters" | "maxItems" | "maxRows",
  raw: string,
): TemplatePackage {
  const parsed = Number(raw);
  const value = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  return patchDraft(draft, (current) => ({
    slots: current.slots.map((slot, position) =>
      position === index ? { ...slot, capacity: { ...slot.capacity, [field]: value } } : slot,
    ),
  }));
}

function validationReport(
  detail: TemplateDetail,
  job: JobSnapshot | null,
): TemplateValidationResult | null {
  if (job?.result?.jobType === "template_validate") return job.result.validation;
  return detail.version.validation?.report ?? null;
}

function versionStatusLabel(detail: TemplateDetail): string {
  if (detail.version.status === "archived") return "已归档";
  if (detail.version.status === "ready") return "已就绪";
  if (detail.version.validation?.status === "failed") return "草稿 · 验证失败";
  if (detail.version.validation?.status === "queued" || detail.version.validation?.status === "running") return "草稿 · 验证中";
  return "草稿 · 未验证";
}

function versionStatusCopy(detail: TemplateDetail): string {
  if (detail.version.status === "ready") return "此版本已由真实验证任务通过。后续修改会建立新草稿，不会原地改动。";
  if (detail.version.validation?.status === "failed") return "验证失败不会改变模板状态。修正结构、槽位或主题后保存新版本，再重新验证。";
  if (detail.version.status === "archived") return "归档版本保留可读快照。历史内容不被删除，也不会成为默认推荐。";
  return "当前只是草稿。页面上的预览和保存成功都不等于 ready。";
}

function validationStatusLabel(status: NonNullable<TemplateDetail["version"]["validation"]>["status"]): string {
  switch (status) {
    case "not_validated": return "未验证";
    case "queued": return "排队中";
    case "running": return "验证中";
    case "passed": return "通过";
    case "failed": return "失败";
    case "cancelled": return "已取消";
  }
}

function jobPhaseLabel(state: JobSnapshot["state"]): string {
  switch (state) {
    case "queued": return "验证已排队";
    case "running": return "正在加载 Chromium 并生成 PDF";
    case "waiting_input": return "等待人工输入";
    case "succeeded": return "验证任务完成";
    case "partial": return "验证部分完成";
    case "failed": return "验证任务失败";
    case "cancelled": return "验证已取消";
  }
}

function capacityLabel(slot: TemplateSlot): string {
  if (slot.capacity.maxCharacters !== undefined) return `≤ ${slot.capacity.maxCharacters} 字符`;
  if (slot.capacity.maxItems !== undefined) return `≤ ${slot.capacity.maxItems} 条`;
  if (slot.capacity.maxRows !== undefined) return `≤ ${slot.capacity.maxRows} 行`;
  return "无文本容量";
}

function kindLabel(kind: TemplatePackage["manifest"]["kind"]): string {
  return kind === "feishu_doc" ? "飞书文档" : "HTML 演示";
}

function parseDeckLayout(value: string): DeckLayout | null {
  return value === "cover" ||
    value === "section" ||
    value === "title-body-media" ||
    value === "two-column" ||
    value === "metric-evidence" ||
    value === "steps" ||
    value === "table" ||
    value === "closing"
    ? value
    : null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
