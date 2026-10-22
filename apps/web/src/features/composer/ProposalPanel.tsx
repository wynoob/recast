import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Proposal, SearchResponse, SubmitCommand } from "@dmall/contracts";
import { useOutletContext } from "react-router";
import type { Health } from "@dmall/contracts";
import { ErrorLine } from "../../ui.js";
import { templateListQuery } from "../templates/api.js";
import { searchContent } from "../assets/api.js";
import { SelectionPanel } from "../assets/SelectionPanel.js";
import { SourceContextPanel } from "../assets/SourceContext.js";

type AdjustCommand = Extract<SubmitCommand, { mode: "adjust" }>;

export function ProposalPanel({ proposal, selection, disabled, onAdjust, onConfirm }: {
  proposal: Proposal;
  selection: NonNullable<NonNullable<AdjustCommand["choices"]>["selection"]>;
  disabled: boolean;
  onAdjust: (command: AdjustCommand) => Promise<void>;
  onConfirm: () => Promise<void>;
}) {
  const { health } = useOutletContext<{ health: Health | undefined }>();
  const [instruction, setInstruction] = useState("");
  const [templateId, setTemplateId] = useState(proposal.template.versionId);
  const [excluded, setExcluded] = useState<string[]>(selection.excludeEvidenceIds);
  const [included, setIncluded] = useState<string[]>(selection.includeHandles);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [source, setSource] = useState<{ id: string; versionId: string } | null>(null);
  const templates = useQuery(templateListQuery({ kind: proposal.delivery.kind, status: "ready" }));
  const entries = "sections" in proposal ? proposal.sections.map((section) => ({ key: section.key, title: section.heading, intent: section.intent, placements: section.placements })) : proposal.slides.map((slide) => ({ key: slide.key, title: slide.title, intent: slide.intent, placements: slide.placements }));
  const selectionChanged = excluded.length !== selection.excludeEvidenceIds.length || excluded.some((id) => !selection.excludeEvidenceIds.includes(id)) || included.length !== selection.includeHandles.length || included.some((id) => !selection.includeHandles.includes(id));
  const hasChoices = templateId !== proposal.template.versionId || selectionChanged;
  const changed = instruction.trim() !== "" || hasChoices;
  const blocking = proposal.gaps.some((gap) => gap.blocksGeneration);

  return <div className="composer-proposal">
    <span className="eyebrow">推荐方案</span><h2>{proposal.title}</h2>
    <p>{proposal.purpose}</p><p className="muted">面向 {proposal.audience} · {proposal.delivery.kind === "feishu_doc" ? "飞书文档" : "HTML 演示"}</p>
    {proposal.delivery.kind === "feishu_doc" ? <p className="muted small">目标目录：{proposal.delivery.folderToken ?? "默认目录"}</p> : null}
    <section className="composer-plan-section"><h3>模板与推荐理由</h3><p>{templates.data?.items.find((item) => item.currentVersionId === proposal.template.versionId)?.name ?? proposal.template.versionId}</p><p>{proposal.template.reason}</p></section>
    <section className="composer-plan-section"><h3>{proposal.delivery.kind === "feishu_doc" ? "章节与图片安排" : "页面与图片安排"}</h3>
      <ol className="composer-outline">{entries.map((entry) => <li key={entry.key}><h4>{entry.title}</h4><p>{entry.intent}</p>{entry.placements.map((placement, index) => {
        const evidence = proposal.evidence.find((item) => item.id === placement.evidenceId);
        return <div className="composer-placement" key={`${placement.evidenceId}-${index}`}><b>{evidence?.title ?? placement.evidenceId}</b><span>{placement.position} · {placement.purpose}</span><small>{placement.use === "comparison" ? "对比使用" : placement.use === "reference" ? "借鉴使用" : placement.use === "illustration" ? "配图" : "论据"} · {evidence?.sourceLabel ?? "来源未列出"}</small></div>;
      })}</li>)}</ol>
    </section>
    <section className="composer-plan-section"><h3>素材与出处</h3>{proposal.evidence.length === 0 ? <p>本方案未选用素材。</p> : proposal.evidence.map((item) => <label className="composer-evidence" key={item.id}><input type="checkbox" checked={!excluded.includes(item.id)} disabled={disabled} onChange={(event) => setExcluded((current) => event.target.checked ? current.filter((id) => id !== item.id) : [...current, item.id])} /><span><b>{item.title}</b><small>{item.sourceLabel} · {item.kind} · {item.availability === "available" ? "可用" : "缺失"}</small><small>商家：{item.merchantId ?? "归属未标明"}</small></span><span className="muted small">取消勾选以排除</span></label>)}</section>
    {proposal.gaps.length === 0 ? null : <section className="composer-plan-section notice warn"><h3>需要补充的内容</h3>{proposal.gaps.map((gap) => <p key={gap.key}>{gap.blocksGeneration ? "生成前必须补充" : "可选补充"}：{gap.question}</p>)}</section>}
    {excluded.length === 0 && included.length === 0 ? null : <div className="dialog-actions wrap">{excluded.length > 0 ? <button className="mini-button" disabled={disabled} onClick={() => setExcluded([])}>清空手动排除（{excluded.length}）</button> : null}{included.length > 0 ? <button className="mini-button" disabled={disabled} onClick={() => setIncluded([])}>清空手动纳入（{included.length}）</button> : null}</div>}
    <form className="dialog-form composer-plan-section" onSubmit={(event) => {
      event.preventDefault();
      if (disabled || !changed) return;
      const choices: NonNullable<AdjustCommand["choices"]> = {
        ...(templateId === proposal.template.versionId ? {} : { templateVersionId: templateId }),
        ...(!selectionChanged ? {} : { selection: { includeHandles: included, excludeEvidenceIds: excluded } }),
      };
      void onAdjust({ mode: "adjust", contentId: proposal.contentId, expectedVersion: proposal.basedOnVersion, ...(instruction.trim() ? { instruction: instruction.trim() } : {}), ...(hasChoices ? { choices } : {}) });
    }}>
      <h3>调整方案</h3><label className="field"><span>替换模板</span><select value={templateId} disabled={disabled} onChange={(event) => setTemplateId(event.target.value)}>
        <option value={proposal.template.versionId}>当前方案模板</option>{templates.data?.items.filter((item) => item.currentVersionId !== null && item.currentVersionId !== proposal.template.versionId).map((item) => <option value={item.currentVersionId ?? ""} key={item.id}>{item.name} · 第 {item.currentVersion} 版</option>)}
      </select></label>{templates.isError ? <ErrorLine message={templates.error.message} /> : null}
      <label className="field"><span>补充或调整要求</span><textarea rows={3} value={instruction} disabled={disabled} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：减少背景，增加店长可执行的操作步骤。也可回答上面的缺口。" /></label>
      <button className="button secondary" disabled={disabled || !changed}>按调整重新规划</button>
    </form>
    <details className="composer-plan-section"><summary>从素材库补充素材</summary><form className="composer-search" onSubmit={async (event) => {
      event.preventDefault();
      if (health === undefined || !query.trim() || searchBusy) return;
      setSearchBusy(true); setSearchError(null);
      try { setSearch(await searchContent({ csrfToken: health.csrfToken, idempotencyKey: crypto.randomUUID(), params: { query: query.trim(), merchantId: null, dateFrom: null, dateTo: null, mediaKinds: [], availability: ["available"] } })); }
      catch (reason) { setSearchError(reason instanceof Error ? reason.message : "检索失败"); }
      finally { setSearchBusy(false); }
    }}><label className="field"><span>素材关键词</span><input value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="button secondary" disabled={disabled || searchBusy || !query.trim()}>检索素材</button></form>
      {searchError === null ? null : <ErrorLine message={searchError} />}{search?.hits.map((hit) => <div className="composer-evidence" key={hit.selectionHandle}><input aria-label={`纳入素材 ${hit.matchedText}`} type="checkbox" disabled={disabled} checked={included.includes(hit.selectionHandle)} onChange={(event) => setIncluded((current) => event.target.checked ? [...current, hit.selectionHandle] : current.filter((id) => id !== hit.selectionHandle))} /><span>{hit.matchedText}</span><button className="mini-button" onClick={() => setHandle(hit.selectionHandle)}>查看出处</button></div>)}
      {search !== null && search.hits.length === 0 ? <p>没有找到匹配的素材。</p> : null}<p className="muted small">新增素材在重新规划后才会进入方案。跨商家对比或借鉴请在要求中说明商家及用途。</p>
    </details>
    <div className="composer-confirm"><p>确认后将按此方案生成全文，并{proposal.delivery.kind === "feishu_doc" ? "新建飞书文档" : "生成 HTML 演示和 ZIP"}。</p><button className="button primary" disabled={disabled || blocking || changed} onClick={() => { void onConfirm(); }}>确认方案并生成成品</button>{blocking ? <p>请先补充必需信息并重新规划。</p> : changed ? <p>请先提交调整，查看新方案后再确认。</p> : null}</div>
    {handle === null ? null : <SelectionPanel handleId={handle} onClose={() => setHandle(null)} onOpenSource={(id, versionId) => { setHandle(null); setSource({ id, versionId }); }} />}
    {source === null ? null : <SourceContextPanel sourceId={source.id} versionId={source.versionId} onClose={() => setSource(null)} />}
  </div>;
}
