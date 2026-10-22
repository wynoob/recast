import { useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SubmitCommandSchema, type CompositionView, type ConfirmCommand, type DeliveryTarget, type Health, type ResumeCommand, type SubmitCommand } from "@dmall/contracts";
import { ApiClientError } from "../../api.js";
import { ErrorLine, LoadingLine } from "../../ui.js";
import { HistoryPage } from "../history/HistoryPage.js";
import { composerApi, compositionQuery } from "./api.js";
import { ProposalPanel } from "./ProposalPanel.js";

type Action =
  | { kind: "submit"; command: SubmitCommand }
  | { kind: "confirm"; command: ConfirmCommand }
  | { kind: "resume"; command: ResumeCommand };
type PendingAction = { action: Action; key: string };
type Selection = NonNullable<NonNullable<Extract<SubmitCommand, { mode: "adjust" }>["choices"]>["selection"]>;
type ShellContext = { health: Health | undefined; openSettings: () => void };

export function ComposerPage() {
  const { id } = useParams();
  return <Composer key={id ?? "new"} contentId={id} />;
}

function Composer({ contentId }: { contentId: string | undefined }) {
  const { health, openSettings } = useOutletContext<ShellContext>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [idea, setIdea] = useState("");
  const [delivery, setDelivery] = useState<DeliveryTarget>({ kind: "feishu_doc", folderToken: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<PendingAction | null>(null);
  const [selection, setSelection] = useState<Selection>(() => readSelection(contentId));
  const locked = useRef(false);
  const composition = useQuery({
    ...compositionQuery(contentId ?? ""),
    enabled: contentId !== undefined,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "planning" || state === "working" || state === "blocked" ? 1500 : false;
    },
  });

  async function run(action: Action, retry = false) {
    if (health === undefined || locked.current) return;
    if (!retry && pending.current !== null) return;
    const request = retry ? pending.current : { action, key: crypto.randomUUID() };
    if (request === null) return;
    pending.current = request;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const options = { csrfToken: health.csrfToken, idempotencyKey: request.key };
      const next = request.action.kind === "submit"
        ? await composerApi.submit(request.action.command, options)
        : request.action.kind === "confirm"
          ? await composerApi.confirm(request.action.command, options)
          : await composerApi.resumeDelivery(request.action.command, options);
      if (request.action.kind === "submit" && request.action.command.mode === "adjust" && request.action.command.choices?.selection !== undefined) {
        setSelection(request.action.command.choices.selection);
        try { localStorage.setItem(`dcw.composer.selection.${next.contentId}`, JSON.stringify(request.action.command)); } catch {}
      }
      pending.current = null;
      client.setQueryData(compositionQuery(next.contentId).queryKey, next);
      void client.invalidateQueries({ queryKey: ["contents"] });
      if (contentId === undefined) navigate(`/contents/${next.contentId}`, { replace: true });
      // A replay can return the original accepted response. Read the current facts next.
      void client.invalidateQueries({ queryKey: compositionQuery(next.contentId).queryKey });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "请求失败");
      if (reason instanceof ApiClientError && reason.status < 500) {
        pending.current = null;
        if (contentId !== undefined) void composition.refetch();
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  if (composition.error instanceof ApiClientError && composition.error.code === "COMPOSITION_NOT_FOUND") return <HistoryPage />;
  const view = composition.data;
  const disabled = busy || health === undefined || pending.current !== null;
  return (
    <div className="page composer-page">
      <div className="page-header">
        <div><span className="eyebrow">AI 创作</span><h1>从想法到成品</h1><p>先看方案，确认后自动写作并交付。</p></div>
        <Link className="button secondary" to="/contents">内容库</Link>
      </div>
      {error === null ? null : <div role="alert"><ErrorLine message={error} />{pending.current === null ? null : <button className="button secondary" disabled={busy} onClick={() => { const request = pending.current; if (request !== null) void run(request.action, true); }}>重试同一请求</button>}</div>}
      {composition.isError ? <div><ErrorLine message={composition.error.message} /><button className="button secondary" onClick={() => { void composition.refetch(); }}>重新读取状态</button></div> : null}
      {contentId !== undefined && composition.isLoading ? <LoadingLine label="正在读取创作" /> : null}
      <div className="composer-grid">
        <aside className="panel composer-request">
          <span className="eyebrow">这次创作</span><h2>说说你的想法</h2>
          {contentId === undefined ? <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (!disabled && idea.trim() !== "") void run({ kind: "submit", command: { mode: "create", idea: idea.trim(), delivery } }); }}>
            <label className="field"><span>想法与要求</span><textarea rows={7} value={idea} disabled={disabled} onChange={(event) => setIdea(event.target.value)} placeholder="为谁写、解决什么问题、希望包含哪些内容？" /></label>
            <fieldset className="format-field" disabled={disabled}><legend>交付成品</legend>
              <label className={`format-option${delivery.kind === "feishu_doc" ? " selected" : ""}`}><input type="radio" name="delivery" checked={delivery.kind === "feishu_doc"} onChange={() => setDelivery({ kind: "feishu_doc", folderToken: null })} /><span><b>飞书文档</b><small>自动新建文档，正文在飞书继续修改</small></span></label>
              <label className={`format-option${delivery.kind === "html_deck" ? " selected" : ""}`}><input type="radio" name="delivery" checked={delivery.kind === "html_deck"} onChange={() => setDelivery({ kind: "html_deck" })} /><span><b>HTML 演示</b><small>在线预览，下载 ZIP 离线打开</small></span></label>
            </fieldset>
            {delivery.kind === "feishu_doc" ? <label className="field"><span>飞书目标文件夹 token（可选）</span><input value={delivery.folderToken ?? ""} disabled={disabled} onChange={(event) => setDelivery({ kind: "feishu_doc", folderToken: event.target.value.trim() || null })} /></label> : null}
            <button className="button primary" type="submit" disabled={disabled || idea.trim() === ""}>{busy ? "正在提交…" : "生成创作方案"}</button>
          </form> : <><p>方案确认后，后台会继续完成。关闭页面后可从内容库重新打开。</p><Link className="button secondary" to={`/contents/${contentId}/history`}>查看修订与历史成品</Link></>}
          <div className="composer-library-links"><Link to="/assets">管理素材</Link><Link to="/templates">管理模板</Link></div>
        </aside>
        <section className="panel composer-stage" aria-label="创作状态">
          {view === undefined && contentId === undefined ? <div className="composer-empty"><h2>方案会在这里展开</h2><p>查看真实模板、素材出处、章节或页面和图片安排，再决定是否生成。</p></div> : null}
          {view?.state === "proposed" ? <ProposalPanel key={view.proposal.id} proposal={view.proposal} selection={selection} disabled={disabled} onAdjust={(command) => run({ kind: "submit", command })} onConfirm={() => run({ kind: "confirm", command: { proposalId: view.proposal.id, proposalHash: view.proposal.hash } })} /> : null}
          {view?.state === "planning" || view?.state === "working" ? <ProgressPanel view={view} /> : null}
          {view?.state === "blocked" ? <BlockedPanel view={view} disabled={disabled} onConfigure={openSettings} onAdjust={(instruction) => run({ kind: "submit", command: { mode: "adjust", contentId: view.contentId, expectedVersion: view.version, instruction } })} onResume={(command) => run({ kind: "resume", command })} /> : null}
          {view?.state === "delivered" ? <DeliveryPanel view={view} /> : null}
        </section>
      </div>
    </div>
  );
}

function ProgressPanel({ view }: { view: Extract<CompositionView, { state: "planning" | "working" }> }) {
  const labels = { intent: "理解创作要求", recommend: "匹配模板与素材", writing: "写作全文", accepting: "保存完整修订", preparing: "准备成品", delivering: "交付成品" };
  const progress = view.progress;
  return <div aria-live="polite"><span className="eyebrow">后台处理中</span><h2>{labels[view.step]}</h2><p>{progress?.message ?? "任务在后台继续，可稍后回来查看。"}</p>{progress?.total !== null && progress?.total !== undefined && progress.total > 0 && progress.done !== null ? <><progress aria-label="当前任务进度" max={progress.total} value={progress.done} /><p>{progress.done} / {progress.total}</p></> : <progress aria-label="当前任务进行中" />}<p className="muted">进度来自已保存的任务记录。</p></div>;
}

function BlockedPanel({ view, disabled, onConfigure, onAdjust, onResume }: {
  view: Extract<CompositionView, { state: "blocked" }>;
  disabled: boolean;
  onConfigure: () => void;
  onAdjust: (instruction: string) => Promise<void>;
  onResume: (command: ResumeCommand) => Promise<void>;
}) {
  const [documentId, setDocumentId] = useState("");
  const [verified, setVerified] = useState(false);
  const [instruction, setInstruction] = useState("");
  return <div><span className="eyebrow">需要处理</span><h2>创作暂时停在这里</h2><p role="status">{view.message}</p><small className="muted">{view.code}</small>
    {view.actions.map((action, index) => <div className="composer-blocked-action" key={`${action.kind}-${index}`}>
      {action.kind === "configure" ? <button className="button secondary" onClick={onConfigure}>配置{action.capability === "text" ? "文本模型" : "飞书"}</button> : null}
      {action.kind === "new_composition" ? <Link className="button secondary" to="/compose">开始另一条创作</Link> : null}
      {action.kind === "adjust" ? <form onSubmit={(event) => { event.preventDefault(); if (!disabled && instruction.trim()) void onAdjust(instruction.trim()); }}><label className="field"><span>补充或调整要求</span><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label><button className="button secondary" disabled={disabled || !instruction.trim()}>重新规划方案</button></form> : null}
      {action.kind === "resume_delivery" ? <button className="button primary" disabled={disabled} onClick={() => { void onResume({ contentId: view.contentId, expectedExportId: action.exportId, expectedDecisionVersion: action.decisionVersion, decision: { kind: "retry_original" } }); }}>恢复原交付</button> : null}
      {action.kind === "verify_remote" ? <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (!disabled && verified && documentId.trim()) void onResume({ contentId: view.contentId, expectedExportId: action.exportId, expectedDecisionVersion: action.decisionVersion, decision: { kind: "bind_verified_document", operationId: action.operationId, documentId: documentId.trim(), confirmedOriginal: true } }); }}>
        <p>请在飞书中核对本次操作创建的原文档。核对后沿原文档继续交付。</p><label className="field"><span>原飞书文档 ID</span><input value={documentId} onChange={(event) => { setDocumentId(event.target.value); setVerified(false); }} /></label>
        <label><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} />我已核对，这是本次操作创建的原文档</label>
        <button className="button primary" disabled={disabled || !verified || !documentId.trim()}>绑定原文档并继续</button>
      </form> : null}
    </div>)}
    {view.availableRevisionId === null ? null : <p>完整本地修订已保存。<Link to={`/contents/${view.contentId}/history?revisionId=${view.availableRevisionId}`}>查看修订</Link></p>}
  </div>;
}

function DeliveryPanel({ view }: { view: Extract<CompositionView, { state: "delivered" }> }) {
  const result = view.result;
  return <div className="composer-delivery"><span className="eyebrow">已交付</span><h2>成品已准备好</h2>{result.kind === "feishu_doc" ? <><p>可在飞书中阅读和继续修改正文。</p><a className="button primary" href={result.url} target="_blank" rel="noreferrer">打开飞书文档</a></> : <><div className="dialog-actions wrap"><a className="button primary" href={result.zip.downloadUrl} download={result.zip.fileName}>下载 ZIP</a><a className="button secondary" href={result.previewUrl} target="_blank" rel="noreferrer">打开 HTML 预览</a></div><p>下载后解压，打开 index.html 即可离线演示。</p><iframe className="composer-preview" title="HTML 演示成品预览" src={result.previewUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" /></>}<p className="muted small">输出 {result.exportId} · 修订 {result.revisionId}</p><Link className="button secondary" to="/compose">开始另一条创作</Link></div>;
}

function readSelection(contentId: string | undefined): Selection {
  try {
    const command = SubmitCommandSchema.safeParse(JSON.parse(localStorage.getItem(`dcw.composer.selection.${contentId}`) ?? "null"));
    if (command.success && command.data.mode === "adjust" && command.data.contentId === contentId && command.data.choices?.selection !== undefined) return command.data.choices.selection;
  } catch {}
  return { includeHandles: [], excludeEvidenceIds: [] };
}
