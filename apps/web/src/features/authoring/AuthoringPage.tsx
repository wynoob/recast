import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Ast,
  AuthoringOperation,
  Block,
  CandidateDecision,
  ContentDetail,
  ContentKind,
  DocAst,
  FixedEvidence,
  Health,
  Inlines,
  MergePreview,
  MessageView,
  RevisionListItem,
  RevisionView,
  Section,
  Slide,
} from "@dmall/contracts";
import {
  acceptCandidate,
  appendMessage,
  briefFromContent,
  confirmPlan,
  createCandidate,
  createGenerationInput,
  deriveRendition,
  evidenceQuery,
  generateLocalDraft,
  generateWithProvider,
  getRevision,
  messagesQuery,
  planQuery,
  providersQuery,
  rejectCandidate,
  retryProviderAttempt,
  restoreRevision,
  revisionsQuery,
  saveRevision,
  selectEvidence,
  transcribeAudio,
  updateTitle,
} from "../../authoring/api.js";
import {
  applyLocalOperations,
  createSection,
  diffAst,
  newBlock,
} from "../../authoring/actions.js";
import { contentQuery, templatesQuery } from "../../api.js";
import { useQuery as useReactQuery } from "@tanstack/react-query";
import { DECK_LAYOUTS, createMoveOperation, fitLabel, newParagraphBlock, newSlide } from "../../editors/deck-adapter.js";
import {
  SAVE_DEBOUNCE_MS,
  RenditionSaveQueues,
  clearPending,
  readPending,
  writePending,
  type SaveStatus,
} from "../../editors/save-queue.js";
import { TiptapInlineEditor, inlinesToPlainText, plainTextToInlines } from "../../editors/doc-adapter.js";
import { Dialog, ErrorLine, Icon, LoadingLine } from "../../ui.js";
import { jobQuery, searchContent } from "../assets/api.js";
import type { SearchHit } from "@dmall/contracts";
import { OutputActions } from "../outputs/OutputActions.js";

interface OutletContext {
  openNew: () => void;
  openTasks: () => void;
  health: Health | undefined;
}

export function AuthoringPage() {
  const { id, renditionId: routeRenditionId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { health } = useOutletContext<OutletContext>();
  const content = useQuery(contentQuery(id ?? ""));
  const rendition = content.data?.renditions.find((item) => item.id === routeRenditionId)
    ?? content.data?.renditions[0];
  const renditionId = rendition?.id;
  const revisionQueryResult = useQuery({
    queryKey: ["authoring", renditionId, "current", rendition?.currentRevisionId],
    queryFn: async () => {
      if (renditionId === undefined || rendition === undefined) throw new Error("稿件分支不存在");
      return getRevision(renditionId, rendition.currentRevisionId);
    },
    enabled: renditionId !== undefined && rendition !== undefined,
  });
  const history = useQuery({
    ...revisionsQuery(renditionId ?? ""),
    enabled: renditionId !== undefined,
  });
  const messages = useQuery({ ...messagesQuery(id ?? ""), enabled: id !== undefined });
  const plan = useQuery({ ...planQuery(id ?? ""), enabled: id !== undefined });
  const evidence = useQuery({ ...evidenceQuery(id ?? ""), enabled: id !== undefined });
  const providers = useQuery(providersQuery());
  const templates = useQuery(templatesQuery);

  const [localAst, setLocalAst] = useState<Ast | null>(null);
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [adoptingBase, setAdoptingBase] = useState(false);
  const adoptingBaseRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deriveOpen, setDeriveOpen] = useState(false);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const initializedRendition = useRef<string | null>(null);
  const savedAstRef = useRef<Ast | null>(null);
  const localAstRef = useRef<Ast | null>(null);
  const baseRevisionRef = useRef<string | null>(null);
  const renditionRef = useRef<string | null>(null);
  const saveQueues = useRef(new RenditionSaveQueues<Ast>());
  const debounceTimer = useRef<number | null>(null);

  useEffect(() => {
    localAstRef.current = localAst;
  }, [localAst]);

  useEffect(() => {
    if (content.data === undefined || rendition === undefined) return;
    if (routeRenditionId === undefined) {
      navigate(`/contents/${content.data.id}/edit/${rendition.id}`, { replace: true });
    }
  }, [content.data, navigate, rendition, routeRenditionId]);

  useEffect(() => {
    if (
      rendition === undefined ||
      revisionQueryResult.data === undefined ||
      initializedRendition.current === rendition.id
    ) {
      return;
    }
    initializedRendition.current = rendition.id;
    renditionRef.current = rendition.id;
    baseRevisionRef.current = revisionQueryResult.data.id;
    setBaseRevisionId(revisionQueryResult.data.id);
    savedAstRef.current = structuredClone(revisionQueryResult.data.ast);
    const pending = readPending<Ast>(rendition.id);
    if (pending !== null && pending.baseRevisionId === revisionQueryResult.data.id) {
      setLocalAst(pending.value);
      localAstRef.current = pending.value;
      setStatus("dirty");
    } else {
      setLocalAst(structuredClone(revisionQueryResult.data.ast));
      localAstRef.current = structuredClone(revisionQueryResult.data.ast);
      setStatus("saved");
    }
  }, [rendition, revisionQueryResult.data]);

  useEffect(() => {
    if (content.data !== undefined && rendition !== undefined && localAst !== null && baseRevisionId !== null) {
      if (JSON.stringify(localAst) !== JSON.stringify(savedAstRef.current)) {
        writePending(rendition.id, baseRevisionId, localAst);
      }
    }
  }, [baseRevisionId, content.data, localAst, rendition]);

  const flushSave = (): void => {
    if (adoptingBaseRef.current || status === "conflict") return;
    const currentRendition = renditionRef.current;
    const currentBase = baseRevisionRef.current;
    const currentLocal = localAstRef.current;
    const saved = savedAstRef.current;
    if (
      currentRendition === null ||
      currentBase === null ||
      currentLocal === null ||
      saved === null ||
      health === undefined ||
      content.data === undefined
    ) {
      return;
    }
    if (JSON.stringify(currentLocal) === JSON.stringify(saved)) {
      setStatus("saved");
      clearPending(currentRendition);
      return;
    }
    const rootNodeId = content.data.renditions.find((item) => item.id === currentRendition)?.rootNodeId;
    if (rootNodeId === undefined) return;
    setStatus("saving");
    saveQueues.current.enqueue({
      snapshot: {
        renditionId: currentRendition,
        baseRevisionId: baseRevisionRef.current!,
        value: currentLocal,
        operations: [],
        claims: [],
        evidenceSelections: evidence.data?.map((item) => item.evidenceId) ?? [],
      },
      send: async (snapshot) => {
        const base = baseRevisionRef.current;
        const savedAst = savedAstRef.current;
        if (base === null || savedAst === null) throw new Error("保存基线尚未就绪");
        const operations = diffAst(savedAst, snapshot.value, rootNodeId);
        if (operations.length === 0) {
          return { revisionId: base, value: snapshot.value };
        }
        const revision = await saveRevision({
          renditionId: currentRendition,
          csrfToken: health.csrfToken,
          request: {
            schemaVersion: 1,
            baseRevisionId: base,
            operations,
            claims: snapshot.claims,
            evidenceSelections: snapshot.evidenceSelections,
          },
        });
        return { revisionId: revision.id, value: snapshot.value };
      },
      onSaved: (result) => {
        savedAstRef.current = structuredClone(result.value);
        baseRevisionRef.current = result.revisionId;
        setBaseRevisionId(result.revisionId);
        setSaveError(null);
        void queryClient.invalidateQueries({ queryKey: ["rendition", currentRendition, "revisions"] });
        void queryClient.invalidateQueries({ queryKey: ["content", content.data?.id] });
        if (JSON.stringify(localAstRef.current) === JSON.stringify(result.value)) {
          setStatus("saved");
          clearPending(currentRendition);
        } else {
          setStatus("dirty");
        }
      },
      onError: (error) => {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        setStatus(code === "REVISION_CONFLICT" ? "conflict" : "error");
        setSaveError(error instanceof Error ? error.message : "保存失败");
      },
    });
  };

  useEffect(() => {
    if (status !== "dirty") return;
    if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    };
  }, [status, localAst]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        flushSave();
      }
    };
    const onOnline = () => flushSave();
    window.addEventListener("keydown", onKey);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("online", onOnline);
    };
  });

  const commit = (operations: AuthoringOperation[]) => {
    const current = localAstRef.current;
    if (current === null || operations.length === 0) return;
    try {
      if (content.data === undefined || rendition === undefined) return;
      const next = applyLocalOperations(current, operations, rendition.rootNodeId);
      localAstRef.current = next;
      setLocalAst(next);
      setStatus("dirty");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "操作无法应用");
    }
  };

  const citeEvidence = (item: FixedEvidence) => {
    const ast = localAstRef.current;
    if (ast === null || rendition === undefined) return;
    if (item.kind === "media") {
      if (item.occurrence === null) return;
      const provenance: import("@dmall/contracts").Provenance = {
        kind: "source",
        sourceVersionId: item.occurrence.sourceVersionId,
        locator: item.occurrence.locator,
      };
      const block: Block = item.mediaKind === "video"
        ? {
            id: crypto.randomUUID(),
            type: "video",
            assetVersionId: item.assetVersionId,
            segmentId: item.segment?.id ?? null,
            posterDerivativeId: item.poster?.id ?? item.derivative?.id ?? "",
            caption: "",
            provenance: [provenance],
            locks: [],
            ...(ast.kind === "html_deck" ? { slotId: null } : {}),
          }
        : {
            id: crypto.randomUUID(),
            type: "image",
            assetVersionId: item.assetVersionId,
            derivativeId: item.derivative?.id ?? null,
            occurrenceId: item.occurrence.requestedOccurrenceId,
            caption: "",
            alt: "选中素材",
            fit: "contain",
            provenance: [provenance],
            locks: [],
            ...(ast.kind === "html_deck" ? { slotId: null } : {}),
          };
      if (block.type === "video" && block.posterDerivativeId === "") return;
      if (ast.kind === "feishu_doc") {
        const section = ast.sections[0];
        if (section === undefined) {
          commit([{
            op: "insertNode",
            parentId: rendition.rootNodeId,
            afterId: null,
            node: { ...createSection(), title: "素材", blocks: [block] },
          }]);
        } else {
          commit([{ op: "insertNode", parentId: section.id, afterId: null, node: block }]);
        }
      } else {
        const slide = ast.slides[0];
        if (slide === undefined) {
          commit([{
            op: "insertNode",
            parentId: rendition.rootNodeId,
            afterId: null,
            node: { ...newSlide(), blocks: [block] },
          }]);
        } else {
          commit([{ op: "insertNode", parentId: slide.id, afterId: null, node: block }]);
        }
      }
      return;
    }
    let text = "";
    let provenance: import("@dmall/contracts").Provenance;
    if (item.kind === "fact") {
      text = item.entity.statement;
      provenance = { kind: "fact", factVersionId: item.entity.factVersionId };
    } else if (item.kind === "source") {
      text = item.exactText.slice(0, 2_000);
      const locator = item.chunks[0]?.locators[0];
      if (locator === undefined) return;
      provenance = { kind: "source", sourceVersionId: item.sourceVersionId, locator };
    } else if (item.kind === "user_assertion") {
      text = item.exactText;
      provenance = { kind: "user_assertion", messageId: item.messageId };
    } else {
      return;
    }
    const block = {
      ...newBlock("paragraph"),
      inlines: plainTextToInlines(text),
      provenance: [provenance],
    };
    if (ast.kind === "feishu_doc") {
      const section = ast.sections[0];
      if (section === undefined) {
        commit([{
          op: "insertNode",
          parentId: rendition.rootNodeId,
          afterId: null,
          node: { ...createSection(), title: "来源摘录", blocks: [block] },
        }]);
      } else {
        commit([{ op: "insertNode", parentId: section.id, afterId: null, node: block }]);
      }
    } else {
      const slide = ast.slides[0];
      if (slide === undefined) {
        const node = { ...newSlide(), blocks: [block] };
        commit([{ op: "insertNode", parentId: rendition.rootNodeId, afterId: null, node }]);
      } else {
        commit([{ op: "insertNode", parentId: slide.id, afterId: null, node: block }]);
      }
    }
  };

  const adoptLatestBase = async (): Promise<void> => {
    if (content.data === undefined || rendition === undefined || adoptingBaseRef.current) return;
    adoptingBaseRef.current = true;
    setAdoptingBase(true);
    try {
      await saveQueues.current.whenIdle(rendition.id);
      await queryClient.cancelQueries({ queryKey: contentQuery(content.data.id).queryKey, exact: true });
      const refreshed = await queryClient.fetchQuery({ ...contentQuery(content.data.id), staleTime: 0 });
      const latestRendition = refreshed.renditions.find((item) => item.id === rendition.id);
      if (latestRendition === undefined) throw new Error("稿件分支不存在");
      const next = await getRevision(latestRendition.id, latestRendition.currentRevisionId);
      if (renditionRef.current !== rendition.id) return;
      savedAstRef.current = structuredClone(next.ast);
      baseRevisionRef.current = next.id;
      setBaseRevisionId(next.id);
      setStatus("dirty");
      setSaveError(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "读取最新修订失败，手改仍保留");
    } finally {
      adoptingBaseRef.current = false;
      setAdoptingBase(false);
    }
  };

  if (id === undefined) return <ErrorLine message="内容地址不完整" />;
  const editorReady = initializedRendition.current === renditionId && localAst !== null;
  if (content.isLoading || (!editorReady && revisionQueryResult.isLoading)) return <LoadingLine label="正在打开创作页" />;
  if (content.isError) return <ErrorLine message={content.error.message} />;
  if (!editorReady && revisionQueryResult.isError) return <ErrorLine message={revisionQueryResult.error.message} />;
  if (content.data === undefined || rendition === undefined || localAst === null) return null;

  const currentKind = localAst.kind;
  const currentPreviewCandidateId = preview?.candidateId ?? null;

  return (
    <div className="authoring-page">
      <header className="authoring-head">
        <div className="authoring-title-block">
          <div className="breadcrumb">
            <a href="/contents">内容库</a><span>/</span>
            <span>{content.data.title}</span>
          </div>
          <ContentTitle
            content={content.data}
            csrfToken={health?.csrfToken}
            onLocalTitle={(value) => {
              commit([{ op: "setField", nodeId: rendition.rootNodeId, path: "title", value }]);
            }}
            onSaved={() => {
              void queryClient.invalidateQueries({ queryKey: ["content", content.data!.id] });
              void queryClient.invalidateQueries({ queryKey: ["contents"] });
            }}
          />
        </div>
        <div className="authoring-head-actions">
          <select
            className="compact-select"
            value={rendition.id}
            onChange={(event) => {
              flushSave();
              navigate(`/contents/${content.data!.id}/edit/${event.target.value}`);
            }}
            aria-label="切换版本分支"
          >
            {content.data.renditions.map((item) => (
              <option key={item.id} value={item.id}>{item.label} · {kindLabel(item.kind)}</option>
            ))}
          </select>
          <button className="button secondary" type="button" onClick={() => { flushSave(); setHistoryOpen(true); }}>历史</button>
          <button className="button secondary" type="button" onClick={() => { flushSave(); setDeriveOpen(true); }}>派生另一格式</button>
          <SaveIndicator status={status} />
        </div>
      </header>

      {status === "conflict" ? (
        <div className="conflict-banner" role="alert">
          <Icon name="alert" />
          <div>
            <b>保存冲突，手改仍保留在本页</b>
            <p>服务器已有新修订。系统没有覆盖你的输入，也没有自动重放旧操作。</p>
          </div>
          <button className="button" type="button" disabled={adoptingBase} onClick={() => void adoptLatestBase()}>
            {adoptingBase ? "正在读取最新修订…" : "采用最新基线并保留手改"}
          </button>
        </div>
      ) : null}
      {saveError !== null ? <div className="inline-error" role="alert">{saveError}</div> : null}

      <div className="authoring-grid">
        <OutlinePanel
          ast={localAst}
          rootNodeId={rendition.rootNodeId}
          activeNodeId={null}
          onCommit={commit}
          onFlush={flushSave}
        />
        <main className="editor-stage" onBlurCapture={() => flushSave()}>
          <div className="editor-toolbar">
            <span className="eyebrow">{currentKind === "feishu_doc" ? "飞书文档" : "HTML 演示"}</span>
            <span className="soft-pill">修订 {baseRevisionId?.slice(0, 8)}</span>
            {rendition.derivedFromRevisionId === null ? null : (
              <span className="soft-pill">派生自 {rendition.derivedFromRevisionId.slice(0, 8)}</span>
            )}
            <span className="editor-toolbar-spacer" />
            <button className="button secondary" type="button" disabled={adoptingBase} onClick={flushSave}>保存</button>
          </div>
          {localAst.kind === "feishu_doc" ? (
            <DocEditor ast={localAst} rootNodeId={rendition.rootNodeId} renditionId={rendition.id} onCommit={commit} />
          ) : (
            <DeckEditor ast={localAst} rootNodeId={rendition.rootNodeId} renditionId={rendition.id} onCommit={commit} />
          )}
        </main>
        <aside className="ai-panel">
          {health === undefined ? null : (
            <OutputActions
              compact
              contentId={content.data.id}
              title={content.data.title}
              renditions={content.data.renditions}
              csrfToken={health.csrfToken}
              activeRenditionId={rendition.id}
              prepareExport={async () => {
                flushSave();
                await saveQueues.current.whenIdle(rendition.id);
                if (JSON.stringify(localAstRef.current) !== JSON.stringify(savedAstRef.current)) {
                  throw new Error("当前修改尚未保存，请解决保存错误后再导出。");
                }
                const savedRevisionId = baseRevisionRef.current;
                if (savedRevisionId === null) throw new Error("保存基线尚未就绪");
                return content.data!.renditions.map((item) => item.id === rendition.id
                  ? { ...item, currentRevisionId: savedRevisionId }
                  : item);
              }}
            />
          )}
          <ChatPanel
            content={content.data}
            rendition={rendition}
            csrfToken={health?.csrfToken}
            messages={messages.data ?? []}
            plan={plan.data}
            evidence={evidence.data ?? []}
            templates={(templates.data?.items ?? []).filter((item) =>
              item.kind === currentKind && item.status === "ready" && item.currentVersionId !== null)}
            providers={providers.data ?? []}
            baseRevisionId={baseRevisionId}
            rootNodeId={rendition.rootNodeId}
            onCandidate={(next) => {
              setPreview(next);
              void queryClient.invalidateQueries({ queryKey: ["authoring", content.data!.id, "messages"] });
            }}
            onJob={setJobId}
            onCite={citeEvidence}
            jobId={jobId}
            currentRevisionId={baseRevisionId}
            onJobCandidate={(candidate) => {
              setPreview(candidate);
              setJobId(null);
            }}
          />
          {currentPreviewCandidateId === null ? null : (
            <CandidatePanel
              candidateId={currentPreviewCandidateId}
              preview={preview!}
              contentId={content.data.id}
              csrfToken={health?.csrfToken}
              expectedRevisionId={baseRevisionId ?? rendition.currentRevisionId}
              plan={plan.data?.confirmation ?? null}
              onResolved={async (revision) => {
                savedAstRef.current = structuredClone(revision.ast);
                baseRevisionRef.current = revision.id;
                setBaseRevisionId(revision.id);
                setLocalAst(structuredClone(revision.ast));
                setStatus("saved");
                setPreview(null);
                await queryClient.invalidateQueries({ queryKey: ["content", content.data!.id] });
                await queryClient.invalidateQueries({ queryKey: ["rendition", rendition.id, "revisions"] });
                await queryClient.invalidateQueries({ queryKey: ["authoring", content.data!.id, "messages"] });
              }}
              onRejected={() => setPreview(null)}
            />
          )}
        </aside>
      </div>

      {historyOpen ? (
        <HistoryDialog
          renditionId={rendition.id}
          currentRevisionId={baseRevisionId ?? rendition.currentRevisionId}
          csrfToken={health?.csrfToken}
          items={history.data?.items ?? []}
          onClose={() => setHistoryOpen(false)}
          onRestored={async (revision) => {
            savedAstRef.current = structuredClone(revision.ast);
            localAstRef.current = structuredClone(revision.ast);
            baseRevisionRef.current = revision.id;
            setLocalAst(structuredClone(revision.ast));
            setBaseRevisionId(revision.id);
            setStatus("saved");
            setHistoryOpen(false);
            await queryClient.invalidateQueries({ queryKey: ["content", content.data!.id] });
            await queryClient.invalidateQueries({ queryKey: ["rendition", rendition.id, "revisions"] });
          }}
        />
      ) : null}
      {deriveOpen ? (
        <DeriveDialog
          content={content.data}
          rendition={rendition}
          fromRevisionId={baseRevisionId ?? rendition.currentRevisionId}
          csrfToken={health?.csrfToken}
          confirmationId={plan.data?.confirmation?.confirmationId ?? null}
          onClose={() => setDeriveOpen(false)}
          onDone={(result) => {
            setDeriveOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["content", content.data!.id] });
            navigate(`/contents/${content.data.id}/edit/${result.renditionId}`);
          }}
        />
      ) : null}
    </div>
  );
}

function ContentTitle(input: {
  content: ContentDetail;
  csrfToken: string | undefined;
  onLocalTitle: (value: string) => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(input.content.title);
  useEffect(() => setValue(input.content.title), [input.content.title]);
  return (
    <input
      className="authoring-title-input"
      value={value}
      maxLength={200}
      aria-label="内容标题"
      onChange={(event) => {
        setValue(event.target.value);
        input.onLocalTitle(event.target.value);
      }}
      onBlur={() => {
        if (input.csrfToken === undefined || value.trim() === "" || value.trim() === input.content.title) return;
        void updateTitle({
          contentId: input.content.id,
          csrfToken: input.csrfToken,
          title: value.trim(),
          expectedVersion: input.content.version,
        }).then(input.onSaved).catch(() => undefined);
      }}
    />
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const text: Record<SaveStatus, string> = {
    saved: "已保存",
    dirty: "未保存 · 800ms 后自动保存",
    saving: "保存中…",
    conflict: "保存冲突 · 手改保留",
    error: "保存失败 · 输入保留",
  };
  return <span className={`save-indicator ${status}`} role="status">{text[status]}</span>;
}

function OutlinePanel(input: {
  ast: Ast;
  rootNodeId: string;
  activeNodeId: string | null;
  onCommit: (operations: AuthoringOperation[]) => void;
  onFlush: () => void;
}) {
  const containers = input.ast.kind === "feishu_doc" ? input.ast.sections : input.ast.slides;
  const add = () => {
    const node = input.ast.kind === "feishu_doc" ? createSection() : newSlide();
    input.onCommit([{ op: "insertNode", parentId: input.rootNodeId, afterId: null, node }]);
  };
  return (
    <aside className="outline-panel">
      <div className="outline-head">
        <span className="eyebrow">结构</span>
        <button className="mini-button" type="button" onClick={add}>＋ {input.ast.kind === "feishu_doc" ? "章节" : "页面"}</button>
      </div>
      <div className="outline-list">
        {containers.map((node, index) => (
          <div className="outline-item-wrap" key={node.id}>
            <a className="outline-item" href={`#node-${node.id}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <b>{node.title || (input.ast.kind === "feishu_doc" ? "未命名章节" : "未命名页面")}</b>
              {"layout" in node ? <small>{DECK_LAYOUTS.find((item) => item.id === node.layout)?.label}</small> : null}
            </a>
            <div className="outline-order">
              <button type="button" disabled={index === 0} onClick={() => {
                const anchor = containers[index - 1];
                if (anchor !== undefined) input.onCommit([{ op: "moveNode", nodeId: node.id, parentId: input.rootNodeId, beforeId: anchor.id }]);
              }}>↑</button>
              <button type="button" disabled={index === containers.length - 1} onClick={() => {
                const anchor = containers[index + 1];
                if (anchor !== undefined) input.onCommit([{ op: "moveNode", nodeId: node.id, parentId: input.rootNodeId, afterId: anchor.id }]);
              }}>↓</button>
            </div>
          </div>
        ))}
        {containers.length === 0 ? <p className="outline-empty">先添加{input.ast.kind === "feishu_doc" ? "一个章节" : "一页演示"}，再写正文。</p> : null}
      </div>
    </aside>
  );
}

function DocEditor(input: { ast: DocAst; rootNodeId: string; renditionId: string; onCommit: (operations: AuthoringOperation[]) => void }) {
  return (
    <div className="doc-canvas">
      {input.ast.sections.map((section) => (
        <section className="doc-section" id={`node-${section.id}`} key={section.id}>
          <SectionTitle section={section} onCommit={input.onCommit} />
          <div className="doc-blocks">
            {section.blocks.map((block, index) => (
              <DocBlock
                key={block.id}
                block={block}
                section={section}
                index={index}
                onCommit={input.onCommit}
              />
            ))}
          </div>
          <div className="add-block-row">
            {(["paragraph", "heading", "callout", "list", "table", "divider"] as const).map((type) => (
              <button
                className="mini-button"
                type="button"
                key={type}
                onClick={() => input.onCommit([{
                  op: "insertNode",
                  parentId: section.id,
                  afterId: null,
                  node: newBlock(type),
                }])}
              >
                ＋ {type === "paragraph" ? "正文" : type === "heading" ? "小标题" : type === "callout" ? "提示" : type === "list" ? "列表" : type === "table" ? "表格" : "分隔线"}
              </button>
            ))}
          </div>
        </section>
      ))}
      {input.ast.sections.length === 0 ? (
        <button
          className="empty-editor-action"
          type="button"
          onClick={() => {
            const section = { ...createSection(), blocks: [newBlock("paragraph")] };
            input.onCommit([{ op: "insertNode", parentId: input.rootNodeId, afterId: null, node: section }]);
          }}
        >
          添加第一个章节并开始写
        </button>
      ) : null}
    </div>
  );
}

function SectionTitle(input: { section: Section; onCommit: (operations: AuthoringOperation[]) => void }) {
  return (
    <div className="section-title-row">
      <input
        value={input.section.title}
        aria-label="章节标题"
        onChange={(event) => input.onCommit([{
          op: "setField",
          nodeId: input.section.id,
          path: "title",
          value: event.target.value,
        }])}
      />
      <LockButton node={input.section} onCommit={input.onCommit} />
      <button
        className="icon-button small"
        type="button"
        aria-label="删除章节"
        onClick={() => input.onCommit([{ op: "removeNode", nodeId: input.section.id }])}
      >×</button>
    </div>
  );
}

function DocBlock(input: {
  block: Block;
  section: Section;
  index: number;
  onCommit: (operations: AuthoringOperation[]) => void;
}) {
  const update = (operations: AuthoringOperation[]) => input.onCommit(operations);
  const listBlock = input.block.type === "list" ? input.block : null;
  const move = (direction: "up" | "down") => {
    const sibling = input.section.blocks[input.index + (direction === "up" ? -1 : 1)];
    if (sibling === undefined) return;
    update([direction === "up"
      ? { op: "moveNode", nodeId: input.block.id, parentId: input.section.id, beforeId: sibling.id }
      : { op: "moveNode", nodeId: input.block.id, parentId: input.section.id, afterId: sibling.id }]);
  };
  return (
    <article className={`doc-block block-${input.block.type}`}>
      <BlockMeta block={input.block} onMove={move} onRemove={() => update([{ op: "removeNode", nodeId: input.block.id }])} onLock={() => update([{
        op: "setField",
        nodeId: input.block.id,
        path: "locks",
        value: input.block.locks.length > 0 ? [] : ["*"],
      }])} />
      {input.block.type === "heading" ? (
        <input
          className="heading-editor"
          value={input.block.text}
          aria-label="小标题"
          onChange={(event) => update([{ op: "setField", nodeId: input.block.id, path: "text", value: event.target.value }])}
        />
      ) : null}
      {input.block.type === "paragraph" || input.block.type === "callout" ? (
        <TiptapInlineEditor
          value={input.block.inlines}
          onChange={(value) => update([{ op: "setField", nodeId: input.block.id, path: "inlines", value }])}
          readOnly={input.block.locks.length > 0}
          ariaLabel={input.block.type === "callout" ? "提示正文" : "段落正文"}
        />
      ) : null}
      {listBlock !== null ? (
        <div className="list-editor">
          {listBlock.items.map((item, index) => {
            const block = listBlock;
            return (
            <div className="list-item-editor" key={`${block.id}-${index}`}>
              <span>{block.ordered ? `${index + 1}.` : "•"}</span>
              <TiptapInlineEditor
                value={item}
                onChange={(value) => {
                  const items = [...block.items];
                  items[index] = value;
                  update([{ op: "setField", nodeId: block.id, path: "items", value: items }]);
                }}
              />
            </div>
            );
          })}
        </div>
      ) : null}
      {input.block.type === "table" ? (
        <TableEditor block={input.block} onChange={(columns, rows) => {
          update([
            { op: "setField", nodeId: input.block.id, path: "columns", value: columns },
            { op: "setField", nodeId: input.block.id, path: "rows", value: rows },
          ]);
        }} />
      ) : null}
      {input.block.type === "image" ? (
        <div className="media-block">
          <Icon name="image" />
          <div><b>图片素材</b><small>素材版本 {input.block.assetVersionId.slice(0, 8)} · {input.block.caption || "无图注"}</small></div>
          <select value={input.block.fit} onChange={(event) => update([{
            op: "setField", nodeId: input.block.id, path: "fit", value: event.target.value as "contain" | "cover",
          }])}>
            <option value="contain">{fitLabel("contain")}</option>
            <option value="cover">{fitLabel("cover")}</option>
          </select>
        </div>
      ) : null}
      {input.block.type === "video" ? (
        <div className="media-block"><Icon name="video" /><b>视频素材</b><span>{input.block.caption || "无说明"}</span></div>
      ) : null}
      {input.block.type === "divider" ? <hr /> : null}
      {input.block.type === "readonly_source_block" ? (
        <div className="readonly-block">
          <Icon name="lock" />
          <div><b>来源只读块</b><p>{input.block.summary}</p><small>{input.block.sourceUrl}</small></div>
        </div>
      ) : null}
      <ProvenanceRow block={input.block} />
    </article>
  );
}

function BlockMeta(input: {
  block: Block;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  onLock: () => void;
}) {
  return (
    <div className="block-meta">
      <span>{blockTypeLabel(input.block.type)}</span>
      {input.block.locks.length > 0 ? <span className="lock-chip"><Icon name="lock" />已锁定</span> : null}
      <span className="block-meta-spacer" />
      <button className="mini-button" type="button" onClick={() => input.onMove("up")}>↑</button>
      <button className="mini-button" type="button" onClick={() => input.onMove("down")}>↓</button>
      <button className="mini-button" type="button" onClick={input.onLock}>{input.block.locks.length > 0 ? "解锁" : "锁定"}</button>
      <button className="mini-button danger" type="button" onClick={input.onRemove}>删除</button>
    </div>
  );
}

function TableEditor(input: {
  block: Extract<Block, { type: "table" }>;
  onChange: (columns: string[], rows: Inlines[][]) => void;
}) {
  return (
    <div className="table-editor-wrap">
      <table>
        <thead>
          <tr>
            {input.block.columns.map((column, index) => (
              <th key={`${input.block.id}-c-${index}`}>
                <input
                  value={column}
                  aria-label={`第 ${index + 1} 列标题`}
                  onChange={(event) => {
                    const columns = [...input.block.columns];
                    columns[index] = event.target.value;
                    input.onChange(columns, input.block.rows);
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {input.block.rows.map((row, rowIndex) => (
            <tr key={`${input.block.id}-r-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${input.block.id}-r-${rowIndex}-c-${cellIndex}`}>
                  <input
                    value={inlinesToPlainText(cell)}
                    aria-label={`第 ${rowIndex + 1} 行第 ${cellIndex + 1} 列`}
                    onChange={(event) => {
                      const rows = structuredClone(input.block.rows);
                      rows[rowIndex]![cellIndex] = plainTextToInlines(event.target.value);
                      input.onChange([...input.block.columns], rows);
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="add-block-row">
        <button className="mini-button" type="button" onClick={() => {
          const columns = [...input.block.columns, `列 ${input.block.columns.length + 1}`];
          const rows = input.block.rows.map((row) => [...row, plainTextToInlines("")]);
          input.onChange(columns, rows);
        }}>＋ 列</button>
        <button className="mini-button" type="button" onClick={() => {
          input.onChange([...input.block.columns], [...input.block.rows, input.block.columns.map(() => plainTextToInlines(""))]);
        }}>＋ 行</button>
      </div>
    </div>
  );
}

function LockButton(input: { node: Section | Slide; onCommit: (operations: AuthoringOperation[]) => void }) {
  return (
    <button
      className="mini-button"
      type="button"
      onClick={() => input.onCommit([{
        op: "setField",
        nodeId: input.node.id,
        path: "locks",
        value: input.node.locks.length > 0 ? [] : ["*"],
      }])}
    >
      {input.node.locks.length > 0 ? "解锁章节" : "锁定章节"}
    </button>
  );
}

function ProvenanceRow({ block }: { block: Block }) {
  if (block.provenance.length === 0) return null;
  return (
    <div className="provenance-row">
      <Icon name="source" />
      {block.provenance.map((item, index) => (
        <span key={index} className="source-chip">
          {item.kind === "source" ? `来源 ${item.sourceVersionId.slice(0, 8)}` : item.kind === "fact" ? `事实 ${item.factVersionId.slice(0, 8)}` : "用户陈述"}
        </span>
      ))}
    </div>
  );
}

function DeckEditor(input: {
  ast: import("@dmall/contracts").DeckAst;
  rootNodeId: string;
  renditionId: string;
  onCommit: (operations: AuthoringOperation[]) => void;
}) {
  const [activeId, setActiveId] = useState(input.ast.slides[0]?.id ?? null);
  const active = input.ast.slides.find((slide) => slide.id === activeId) ?? input.ast.slides[0];
  return (
    <div className="deck-editor">
      <div className="deck-thumbs">
        {input.ast.slides.map((slide, index) => (
          <div className="deck-thumb-wrap" key={slide.id}>
            <button
              type="button"
              className={`deck-thumb${slide.id === active?.id ? " active" : ""}`}
              onClick={() => setActiveId(slide.id)}
            >
              <span>{index + 1}</span>
              <b>{slide.title || "未命名页面"}</b>
              <small>{DECK_LAYOUTS.find((item) => item.id === slide.layout)?.label}</small>
            </button>
            <div className="deck-thumb-actions">
              <button type="button" disabled={index === 0} onClick={() => {
                const anchor = input.ast.slides[index - 1];
                if (anchor !== undefined) input.onCommit([{ op: "moveNode", nodeId: slide.id, parentId: input.rootNodeId, beforeId: anchor.id }]);
              }}>↑</button>
              <button type="button" disabled={index === input.ast.slides.length - 1} onClick={() => {
                const anchor = input.ast.slides[index + 1];
                if (anchor !== undefined) input.onCommit([{ op: "moveNode", nodeId: slide.id, parentId: input.rootNodeId, afterId: anchor.id }]);
              }}>↓</button>
            </div>
          </div>
        ))}
        <button className="button secondary" type="button" onClick={() => {
          const node = newSlide();
          node.blocks = [newParagraphBlock("body")];
          input.onCommit([{ op: "insertNode", parentId: input.rootNodeId, afterId: null, node }]);
          setActiveId(node.id);
        }}>＋ 新页面</button>
      </div>
      {active === undefined ? (
        <button className="empty-editor-action" type="button" onClick={() => {
          const node = newSlide();
          node.blocks = [newParagraphBlock("body")];
          input.onCommit([{ op: "insertNode", parentId: input.rootNodeId, afterId: null, node }]);
          setActiveId(node.id);
        }}>添加第一页演示并开始编辑</button>
      ) : (
        <div className="deck-canvas-wrap">
          <div className={`deck-canvas layout-${active.layout}`}>
            <div className="deck-canvas-head">
              <input
                className="deck-title-input"
                value={active.title}
                aria-label="页面标题"
                onChange={(event) => input.onCommit([{
                  op: "setField", nodeId: active.id, path: "title", value: event.target.value,
                }])}
              />
              <select value={active.layout} onChange={(event) => input.onCommit([{
                op: "setField", nodeId: active.id, path: "layout", value: event.target.value as Slide["layout"],
              }])} aria-label="页面版式">
                {DECK_LAYOUTS.map((layout) => <option key={layout.id} value={layout.id}>{layout.label}</option>)}
              </select>
            </div>
            <div className="deck-body">
              {active.blocks.map((block) => (
                <div className="deck-slot-block" key={block.id}>
                  <div className="deck-slot-tools">
                    <span>{block.slotId ?? "未放置槽位"}</span>
                    <button className="mini-button" type="button" onClick={() => {
                      const operation = createMoveOperation({ slide: active, blockId: block.id, direction: "up" });
                      if (operation !== null) input.onCommit([operation]);
                    }}>↑</button>
                    <button className="mini-button" type="button" onClick={() => {
                      const operation = createMoveOperation({ slide: active, blockId: block.id, direction: "down" });
                      if (operation !== null) input.onCommit([operation]);
                    }}>↓</button>
                    <button className="mini-button" type="button" onClick={() => input.onCommit([{
                      op: "setField", nodeId: block.id, path: "locks", value: block.locks.length > 0 ? [] : ["*"],
                    }])}>{block.locks.length > 0 ? "解锁" : "锁定"}</button>
                    <button className="mini-button danger" type="button" onClick={() => input.onCommit([{ op: "removeNode", nodeId: block.id }])}>删除</button>
                  </div>
                  {block.type === "paragraph" || block.type === "callout" ? (
                    <TiptapInlineEditor
                      value={block.inlines}
                      onChange={(value) => input.onCommit([{ op: "setField", nodeId: block.id, path: "inlines", value }])}
                      readOnly={block.locks.length > 0}
                    />
                  ) : block.type === "heading" ? (
                    <input className="heading-editor" value={block.text} onChange={(event) => input.onCommit([{
                      op: "setField", nodeId: block.id, path: "text", value: event.target.value,
                    }])} />
                  ) : block.type === "image" ? (
                    <div className="media-block"><Icon name="image" /><span>{block.caption || "图片素材"}</span><select value={block.fit} onChange={(event) => input.onCommit([{
                      op: "setField", nodeId: block.id, path: "fit", value: event.target.value as "contain" | "cover",
                    }])}><option value="contain">完整显示</option><option value="cover">铺满裁切</option></select></div>
                  ) : block.type === "video" ? (
                    <div className="media-block"><Icon name="video" /><span>{block.caption || "视频素材"}</span></div>
                  ) : block.type === "table" ? (
                    <TableEditor block={block} onChange={(columns, rows) => input.onCommit([
                      { op: "setField", nodeId: block.id, path: "columns", value: columns },
                      { op: "setField", nodeId: block.id, path: "rows", value: rows },
                    ])} />
                  ) : block.type === "readonly_source_block" ? (
                    <div className="readonly-block"><Icon name="lock" /><p>{block.summary}</p></div>
                  ) : block.type === "divider" ? <hr /> : null}
                </div>
              ))}
            </div>
            <div className="deck-footer">
              <button className="mini-button" type="button" onClick={() => input.onCommit([{
                op: "insertNode", parentId: active.id, afterId: null, node: newParagraphBlock(),
              }])}>＋ 正文</button>
              <span>{DECK_LAYOUTS.find((item) => item.id === active.layout)?.hint}</span>
            </div>
          </div>
          <label className="field notes-field">
            <span>讲稿</span>
            <textarea
              value={active.speakerNotes}
              onChange={(event) => input.onCommit([{
                op: "setField", nodeId: active.id, path: "speakerNotes", value: event.target.value,
              }])}
              rows={5}
              placeholder="讲稿只保存在项目包和历史修订中，默认不进入对外演示。"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function ChatPanel(input: {
  content: ContentDetail;
  rendition: ContentDetail["renditions"][number];
  csrfToken: string | undefined;
  messages: MessageView[];
  plan: import("../../authoring/api.js").PlanResponse | undefined;
  evidence: FixedEvidence[];
  templates: import("@dmall/contracts").TemplateSummary[];
  providers: import("@dmall/contracts").ProviderConfigView[];
  baseRevisionId: string | null;
  rootNodeId: string;
  onCandidate: (preview: MergePreview) => void;
  onJob: (jobId: string) => void;
  onCite: (item: FixedEvidence) => void;
  jobId: string | null;
  onJobCandidate: (preview: MergePreview) => void;
  currentRevisionId: string | null;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [goal, setGoal] = useState(input.content.brief.goal);
  const [tone, setTone] = useState(input.content.brief.tone);
  const [audience, setAudience] = useState(input.content.brief.audience.join("、"));
  const [duration, setDuration] = useState(input.content.brief.durationMinutes === null ? "" : String(input.content.brief.durationMinutes));
  const [outline, setOutline] = useState(input.content.brief.userOutline);
  const [selectedTemplate, setSelectedTemplate] = useState(input.templates[0]?.currentVersionId ?? "");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [transcribeJobId, setTranscribeJobId] = useState<string | null>(null);
  const [generationInputHash, setGenerationInputHash] = useState<string | null>(null);
  const [gapMessages, setGapMessages] = useState<Record<number, string>>({});
  const audioInput = useRef<HTMLInputElement | null>(null);
  const textProvider = input.providers.find((item) => item.role === "text");
  const generationInputRef = useRef<string | null>(null);

  const addChapter = () => setOutline((current) => [...current, { id: crypto.randomUUID(), title: `章节 ${current.length + 1}` }]);

  const saveNote = async () => {
    if (input.csrfToken === undefined || note.trim() === "") return;
    setBusy("note");
    setError(null);
    try {
      await appendMessage({
        contentId: input.content.id,
        csrfToken: input.csrfToken,
        request: {
          schemaVersion: 1,
          mode: "note",
          text: note.trim(),
          renditionId: input.rendition.id,
          targetNodeIds: [],
        },
      });
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["authoring", input.content.id, "messages"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "消息保存失败");
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (input.csrfToken === undefined || outline.length === 0) return;
    setBusy("plan");
    setError(null);
    try {
      const parsedDuration = duration.trim() === "" ? null : Number(duration);
      if (parsedDuration !== null && (!Number.isFinite(parsedDuration) || parsedDuration <= 0)) {
        throw new Error("时长必须是正数，可填写 2.5；留空表示未指定");
      }
      const brief = briefFromContent(input.content);
      await confirmPlan({
        contentId: input.content.id,
        csrfToken: input.csrfToken,
        expectedVersion: input.content.version,
        brief: {
          ...brief,
          goal,
          tone,
          audience: audience.split(/[、,，]/u).map((item) => item.trim()).filter(Boolean),
          durationMinutes: parsedDuration,
          userOutline: outline,
          mustKeepOutline: true,
        },
        outline,
        renditionId: input.rendition.id,
        questionDecisions: input.content.brief.unresolvedQuestions.map((originalText, index) => {
          const messageId = gapMessages[index];
          return messageId === undefined
            ? { index, originalText, action: "keep_blocking" as const }
            : { index, originalText, action: "continue_with_gap" as const, messageId };
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ["authoring", input.content.id, "plan"] });
      await queryClient.invalidateQueries({ queryKey: ["content", input.content.id] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "需求确认失败");
    } finally {
      setBusy(null);
    }
  };

  const recordGap = async (index: number, question: string) => {
    if (input.csrfToken === undefined) return;
    setBusy(`gap-${index}`);
    try {
      const message = await appendMessage({
        contentId: input.content.id,
        csrfToken: input.csrfToken,
        request: {
          schemaVersion: 1,
          mode: "note",
          text: `已知缺口：${question}`,
          renditionId: input.rendition.id,
          targetNodeIds: [],
        },
      });
      setGapMessages((current) => ({ ...current, [index]: message.message.id }));
      await queryClient.invalidateQueries({ queryKey: ["authoring", input.content.id, "messages"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "缺口说明保存失败");
    } finally {
      setBusy(null);
    }
  };

  const doSearch = async () => {
    if (input.csrfToken === undefined || search.trim() === "") return;
    setBusy("search");
    setError(null);
    try {
      const response = await searchContent({
        params: {
          query: search,
          merchantId: input.content.brief.merchantId,
          dateFrom: null,
          dateTo: null,
          mediaKinds: [],
          availability: ["available"],
        },
        csrfToken: input.csrfToken,
        idempotencyKey: crypto.randomUUID(),
      });
      setHits(response.hits);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "检索失败");
    } finally {
      setBusy(null);
    }
  };

  const fixHit = async (hit: SearchHit) => {
    if (input.csrfToken === undefined) return;
    setBusy(`select-${hit.selectionHandle}`);
    try {
      await selectEvidence({
        contentId: input.content.id,
        csrfToken: input.csrfToken,
        handles: [hit.selectionHandle],
      });
      await queryClient.invalidateQueries({ queryKey: ["authoring", input.content.id, "evidence"] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "固定证据失败");
    } finally {
      setBusy(null);
    }
  };

  const prepareInput = async (): Promise<string | null> => {
    if (input.csrfToken === undefined || input.baseRevisionId === null) return null;
    const confirmation = input.plan?.confirmation;
    if (confirmation === undefined || confirmation === null) {
      throw new Error("请先确认需求与章节");
    }
    if (selectedTemplate === "") throw new Error("请选择 ready 模板");
    const fixed = await createGenerationInput({
      contentId: input.content.id,
      renditionId: input.rendition.id,
      csrfToken: input.csrfToken,
      request: {
        schemaVersion: 1,
        baseRevisionId: input.baseRevisionId,
        confirmationId: confirmation.confirmationId,
        templateVersionId: selectedTemplate,
        selectedEvidenceIds: input.evidence.map((item) => item.evidenceId),
        targetNodeIds: [input.rootNodeId],
        unplacedOwnerMap: {},
      },
    });
    generationInputRef.current = fixed.id;
    setGenerationInputHash(fixed.inputHash);
    return fixed.id;
  };

  const localDraft = async () => {
    setBusy("local");
    setError(null);
    try {
      const inputId = await prepareInput();
      if (inputId === null || input.csrfToken === undefined) return;
      const result = await generateLocalDraft({
        contentId: input.content.id,
        renditionId: input.rendition.id,
        inputId,
        csrfToken: input.csrfToken,
      });
      setLocalNotice(result.warnings.length > 0 ? result.warnings.join("；") : "本地结构草稿已生成。");
      input.onCandidate(await loadPreview(result.candidate.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本地草稿生成失败");
    } finally {
      setBusy(null);
    }
  };

  const remoteGenerate = async () => {
    setBusy("remote");
    setError(null);
    try {
      const inputId = await prepareInput();
      if (inputId === null || input.csrfToken === undefined) return;
      const job = await generateWithProvider({ inputId, csrfToken: input.csrfToken });
      input.onJob(job.id);
      setLocalNotice("AI 任务已创建。关闭页面不会丢失；结果会先写入 journal，再生成候选。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI 任务创建失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="chat-panel">
      <div className="panel-title-row">
        <div><span className="eyebrow">AI 创作</span><h2>需求、素材与差异</h2></div>
        <span className="soft-pill">{input.rendition.label}</span>
      </div>
      <div className="message-stack">
        {input.messages.length === 0 ? <p className="panel-hint">还没有对话。先记录口述思路，再确认需求和章节。</p> : null}
        {input.messages.slice(-12).map((message) => (
          <div className={`message ${message.role} mode-${message.mode}`} key={message.id}>
            <span>{message.role === "user" ? "你" : message.mode === "confirm_outline" ? "确认" : "工作台"}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </div>
      <div className="chat-composer">
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="记录口述思路、修改要求或待补说明…" />
        <div className="chat-composer-actions">
          <span className="provider-state">{input.providers.find((item) => item.role === "text")?.configured ? "文本模型已填写，未验证" : "文本模型未配置 · 笔记仍可保存"}</span>
          <input
            ref={audioInput}
            type="file"
            accept="audio/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file === undefined || input.csrfToken === undefined) return;
              setBusy("transcribe");
              setError(null);
              void fileToBase64(file).then((audioBase64) => transcribeAudio({
                contentId: input.content.id,
                renditionId: input.rendition.id,
                csrfToken: input.csrfToken!,
                audioBase64,
                mimeType: file.type || "audio/webm",
                language: "zh",
              })).then((job) => {
                setTranscribeJobId(job.id);
              }).catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : "录音转写任务创建失败");
              }).finally(() => setBusy(null));
            }}
          />
          <button
            className="mini-button"
            type="button"
            disabled={busy !== null || input.providers.find((item) => item.role === "asr")?.configured !== true}
            onClick={() => audioInput.current?.click()}
            title={input.providers.find((item) => item.role === "asr")?.configured === true ? undefined : "语音转写未配置"}
          >录音转写</button>
          <button className="button primary" type="button" disabled={busy !== null || note.trim() === ""} onClick={() => void saveNote()}>保存笔记</button>
        </div>
        {transcribeJobId === null ? null : (
          <TranscriptionWatcher
            jobId={transcribeJobId}
            contentId={input.content.id}
            renditionId={input.rendition.id}
            csrfToken={input.csrfToken}
            onDone={async () => {
              setTranscribeJobId(null);
              await queryClient.invalidateQueries({ queryKey: ["authoring", input.content.id, "messages"] });
            }}
          />
        )}
      </div>

      <section className="panel-subsection">
        <div className="panel-title-row">
          <div><span className="eyebrow">Step 1</span><h3>需求与章节</h3></div>
          <span className={`soft-pill ${input.plan?.current ? "ok" : ""}`}>{input.plan?.current ? "已确认" : "待确认"}</span>
        </div>
        <label className="field"><span>目标</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} /></label>
        <div className="two-column-fields">
          <label className="field"><span>语气</span><input value={tone} onChange={(event) => setTone(event.target.value)} placeholder="例如：克制、清晰" /></label>
          <label className="field"><span>时长（分钟）</span><input value={duration} onChange={(event) => setDuration(event.target.value)} inputMode="decimal" placeholder="留空或 2.5" /></label>
        </div>
        <label className="field"><span>听众</span><input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="用顿号或逗号分隔" /></label>
        {input.content.brief.unresolvedQuestions.length === 0 ? null : (
          <div className="question-list">
            {input.content.brief.unresolvedQuestions.map((question, index) => (
              <div className={`question-row ${gapMessages[index] === undefined ? "blocking" : "continued"}`} key={`${question}-${index}`}>
                <span>{index + 1}</span>
                <p>{question}</p>
                {gapMessages[index] === undefined ? (
                  <button className="mini-button" type="button" disabled={busy !== null} onClick={() => void recordGap(index, question)}>
                    记录缺口并继续
                  </button>
                ) : <span className="soft-pill">已记录，继续时保留缺口</span>}
              </div>
            ))}
          </div>
        )}
        <div className="outline-edit-list">
          {outline.map((item, index) => (
            <div key={item.id} className="outline-edit-row">
              <span>{index + 1}</span>
              <input value={item.title} onChange={(event) => setOutline((current) =>
                current.map((entry) => entry.id === item.id ? { ...entry, title: event.target.value } : entry))} />
              <button className="mini-button" type="button" onClick={() => setOutline((current) => current.filter((entry) => entry.id !== item.id))}>删除</button>
            </div>
          ))}
        </div>
        <div className="button-row">
          <button className="mini-button" type="button" onClick={addChapter}>＋ 章节</button>
          <button className="button" type="button" disabled={busy !== null || outline.length === 0} onClick={() => void confirm()}>确认需求</button>
        </div>
        {input.plan?.confirmation !== undefined && input.plan?.confirmation !== null ? (
          <p className="panel-hint">固定确认 {input.plan.confirmation.confirmationId.slice(0, 8)} · 计划 hash {input.plan.confirmation.planHash.slice(0, 8)}</p>
        ) : null}
      </section>

      <section className="panel-subsection">
        <div className="panel-title-row">
          <div><span className="eyebrow">Step 2</span><h3>固定素材</h3></div>
          <span className="soft-pill">{input.evidence.length} 项</span>
        </div>
        <div className="search-row">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索历史材料…" />
          <button className="button" type="button" disabled={busy !== null} onClick={() => void doSearch()}>检索</button>
        </div>
        {hits.length > 0 ? (
          <div className="hit-list">
            {hits.slice(0, 5).map((hit) => (
              <div className="hit-row" key={hit.selectionHandle}>
                <div><b>{hit.sourceTitle ?? "事实"}</b><p>{hit.matchedText}</p><small>{hit.reason}</small></div>
                <button className="mini-button" type="button" disabled={busy !== null} onClick={() => void fixHit(hit)}>固定</button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="evidence-list">
          {input.evidence.map((item) => (
            <div className="evidence-row" key={item.evidenceId}>
              <span className="source-chip">{item.kind === "fact" ? "事实" : item.kind === "source" ? "来源" : item.kind === "media" ? "媒体" : "陈述"}</span>
              <div>
                <b>{item.kind === "fact" ? item.entity.statement : item.kind === "source" ? item.exactText.slice(0, 80) : item.evidenceId.slice(0, 8)}</b>
                <small>{item.kind === "fact"
                  ? `${item.entity.indexText.codePoints} 码点 · 完整 FactEntity`
                  : item.kind === "source"
                    ? item.entityHash.slice(0, 12)
                    : item.kind === "media"
                      ? item.blobHash.slice(0, 12)
                      : item.textHash.slice(0, 12)}</small>
              </div>
              <button className="mini-button" type="button" onClick={() => input.onCite(item)}>插入引用</button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-subsection">
        <div className="panel-title-row">
          <div><span className="eyebrow">Step 3</span><h3>模板与初稿</h3></div>
        </div>
        <label className="field">
          <span>ready 模板</span>
          <select value={selectedTemplate} onChange={(event) => setSelectedTemplate(event.target.value)}>
            <option value="">选择模板</option>
            {input.templates.map((template) => (
              <option value={template.currentVersionId!} key={template.id}>{template.name} · v{template.currentVersion}</option>
            ))}
          </select>
        </label>
        <div className="button-row">
          <button className="button secondary" type="button" disabled={busy !== null} onClick={() => void localDraft()}>
            本地模板结构草稿
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy !== null || textProvider?.verified !== true}
            onClick={() => void remoteGenerate()}
            title={textProvider?.verified !== true ? "文本模型未配置或未验证；不会伪造生成成功" : undefined}
          >
            AI 生成
          </button>
        </div>
        <p className="panel-hint">本地结构草稿是规则结果，不是模型生成。AI 生成需要已填写并验证的文本模型。</p>
        {localNotice === null ? null : <div className="inline-success">{localNotice}</div>}
        {input.jobId === null ? null : (
          <ProviderJobWatcher
            jobId={input.jobId}
            renditionId={input.rendition.id}
            csrfToken={input.csrfToken}
            expectedRevisionId={input.currentRevisionId}
            expectedInputHash={generationInputHash}
            onCandidate={input.onJobCandidate}
          />
        )}
      </section>
      {error === null ? null : <ErrorLine message={error} />}
    </div>
  );
}

function TranscriptionWatcher(input: {
  jobId: string;
  contentId: string;
  renditionId: string;
  csrfToken: string | undefined;
  onDone: () => Promise<void>;
}) {
  const job = useReactQuery({
    ...jobQuery(input.jobId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "succeeded" || state === "failed" || state === "cancelled" || state === "waiting_input" ? false : 1000;
    },
  });
  const saved = useRef(false);
  useEffect(() => {
    const snapshot = job.data;
    if (saved.current || snapshot?.state !== "succeeded" || snapshot.result?.jobType !== "authoring_transcription") return;
    if (input.csrfToken === undefined) return;
    saved.current = true;
    void appendMessage({
      contentId: input.contentId,
      csrfToken: input.csrfToken,
      request: {
        schemaVersion: 1,
        mode: "note",
        text: snapshot.result.text,
        renditionId: input.renditionId,
        targetNodeIds: [],
      },
    }).then(input.onDone).catch(() => undefined);
  }, [input, job.data, input.onDone]);
  return (
    <div className="job-progress-card">
      <b>转写：{job.data?.state ?? "读取中"}</b>
      <p>{job.data?.error?.message ?? "转写文本会作为可编辑笔记保存，不会自动生成正文。"}</p>
    </div>
  );
}

function ProviderJobWatcher(input: {
  jobId: string;
  renditionId: string;
  csrfToken: string | undefined;
  expectedRevisionId: string | null;
  expectedInputHash: string | null;
  onCandidate: (preview: MergePreview) => void;
}) {
  const job = useReactQuery({
    ...jobQuery(input.jobId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "succeeded" || state === "failed" || state === "cancelled" || state === "waiting_input" ? false : 1000;
    },
  });
  const created = useRef(false);
  const queryClient = useQueryClient();
  useEffect(() => {
    const snapshot = job.data;
    if (
      created.current ||
      snapshot?.state !== "succeeded" ||
      input.csrfToken === undefined ||
      input.expectedRevisionId === null
    ) return;
    if (snapshot.result?.jobType !== "authoring_provider") return;
    created.current = true;
    void createCandidate({
      renditionId: input.renditionId,
      csrfToken: input.csrfToken,
      body: {
        schemaVersion: 1,
        inputId: snapshot.result.inputId,
        expectedRevisionId: input.expectedRevisionId,
        operations: snapshot.result.operations,
        claims: snapshot.result.claims,
        modelRunId: input.jobId,
      },
    }).then(async (candidate) => {
      input.onCandidate(await loadPreview(candidate.id));
    }).catch(() => undefined);
  }, [input.csrfToken, input.expectedRevisionId, input.jobId, input.renditionId, job.data, input.onCandidate]);
  return (
    <div className="job-progress-card">
      <span className="eyebrow">模型任务</span>
      <b>{job.data?.state ?? "读取中"}</b>
      <p>{job.data?.error?.message ?? job.data?.phase ?? "任务已排队"}</p>
      {job.data?.state === "waiting_input" ? <p>结果未知或需要决定。系统没有自动重发请求。</p> : null}
      {job.data?.state === "waiting_input" && input.expectedInputHash !== null && input.csrfToken !== undefined ? (
        <button className="button secondary" type="button" onClick={() => {
          void retryProviderAttempt({
            jobId: input.jobId,
            csrfToken: input.csrfToken!,
            expectedInputHash: input.expectedInputHash!,
          }).then(async () => {
            created.current = false;
            await queryClient.invalidateQueries({ queryKey: ["job", input.jobId] });
          });
        }}>明确创建新尝试（可能产生重复费用）</button>
      ) : null}
    </div>
  );
}

function CandidatePanel(input: {
  candidateId: string;
  preview: MergePreview;
  contentId: string;
  csrfToken: string | undefined;
  expectedRevisionId: string;
  plan: import("@dmall/contracts").ConfirmationView | null;
  onResolved: (revision: RevisionView) => Promise<void>;
  onRejected: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, "keep_current" | "accept_candidate">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [frozenAck, setFrozenAck] = useState<{
    confirmationId: string;
    contentVersion: number;
    planHash: string;
    messageId: string;
  } | null>(null);

  const setAll = (choice: "keep_current" | "accept_candidate") => {
    setDecisions(Object.fromEntries(input.preview.conflictGroupIds.map((id) => [id, choice])));
  };
  const accept = async (ack = frozenAck) => {
    if (input.csrfToken === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const selected: CandidateDecision[] = input.preview.conflictGroupIds.map((groupId) => ({
        groupId,
        choice: decisions[groupId] ?? "keep_current",
      }));
      const result = await acceptCandidate({
        candidateId: input.candidateId,
        csrfToken: input.csrfToken,
        expectedRevisionId: input.expectedRevisionId,
        previewToken: input.preview.previewToken,
        decisions: selected,
        frozenPlanAcknowledgement: ack,
      });
      await input.onResolved(result.revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "接受候选失败");
      setErrorCode(typeof reason === "object" && reason !== null && "code" in reason ? String(reason.code) : null);
    } finally {
      setBusy(false);
    }
  };
  const acknowledgeOldPlan = async () => {
    if (input.csrfToken === undefined || input.plan === null) return;
    setBusy(true);
    try {
      const message = await appendMessage({
        contentId: input.contentId,
        csrfToken: input.csrfToken,
        request: {
          schemaVersion: 1,
          mode: "note",
          text: `确认继续使用旧需求计划 ${input.plan.planHash.slice(0, 12)}`,
          renditionId: null,
          targetNodeIds: [],
        },
      });
      const ack = {
        confirmationId: input.plan.confirmationId,
        contentVersion: input.plan.contentVersion,
        planHash: input.plan.planHash,
        messageId: message.message.id,
      };
      setFrozenAck(ack);
      await accept(ack);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "旧计划确认失败");
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (input.csrfToken === undefined) return;
    setBusy(true);
    try {
      await rejectCandidate({
        candidateId: input.candidateId,
        csrfToken: input.csrfToken,
        expectedRevisionId: input.expectedRevisionId,
      });
      input.onRejected();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "拒绝候选失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="candidate-panel">
      <div className="panel-title-row">
        <div><span className="eyebrow">差异审核</span><h3>{input.preview.groups.length} 个变更组</h3></div>
        <span className="soft-pill">{input.preview.conflictGroupIds.length} 冲突</span>
      </div>
      <div className="diff-summary">
        <span>自动 {input.preview.automaticGroupIds.length}</span>
        <span>已一致 {input.preview.satisfiedGroupIds.length}</span>
        <span>冲突 {input.preview.conflictGroupIds.length}</span>
        <span>阻塞 {input.preview.blockedGroupIds.length}</span>
      </div>
      <div className="diff-groups">
        {input.preview.groups.map((group) => (
          <div className={`diff-group ${group.classification}`} key={group.groupId}>
            <div className="diff-group-head">
              <b>{group.classification === "automatic" ? "自动合并" : group.classification === "satisfied" ? "已一致" : group.classification === "blocked" ? "阻塞" : "需要选择"}</b>
              <span>{group.semanticTags.join(" · ") || group.kind}</span>
            </div>
            <div className="diff-values">
              <ValueColumn label="基线" value={group.baseValue} />
              <ValueColumn label="我的手改" value={group.currentValue} />
              <ValueColumn label="AI 建议" value={group.candidateValue} />
            </div>
            {group.classification === "conflict" ? (
              <div className="choice-row">
                <button className={decisions[group.groupId] !== "accept_candidate" ? "active" : ""} type="button" onClick={() =>
                  setDecisions((current) => ({ ...current, [group.groupId]: "keep_current" }))}>保留我的修改</button>
                <button className={decisions[group.groupId] === "accept_candidate" ? "active" : ""} type="button" onClick={() =>
                  setDecisions((current) => ({ ...current, [group.groupId]: "accept_candidate" }))}>接受建议</button>
              </div>
            ) : null}
            {group.reason === null ? null : <small>{group.reason}</small>}
          </div>
        ))}
      </div>
      <div className="button-row">
        <button className="mini-button" type="button" onClick={() => setAll("keep_current")}>全部保留当前</button>
        <button className="mini-button" type="button" onClick={() => setAll("accept_candidate")}>全部接受建议</button>
        <button className="button" type="button" disabled={busy} onClick={() => void reject()}>拒绝候选</button>
        <button className="button primary" type="button" disabled={busy} onClick={() => void accept()}>
          {busy ? "正在提交…" : "接受并创建修订"}
        </button>
      </div>
      {error === null ? null : <ErrorLine message={error} />}
      {errorCode === "PLAN_ACK_REQUIRED" ? (
        <button className="button secondary" type="button" disabled={busy} onClick={() => void acknowledgeOldPlan()}>
          明确确认继续使用旧计划
        </button>
      ) : null}
    </section>
  );
}

function ValueColumn({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return <div><span>{label}</span><pre>{text.length > 280 ? `${text.slice(0, 280)}…` : text}</pre></div>;
}

function HistoryDialog(input: {
  renditionId: string;
  currentRevisionId: string;
  csrfToken: string | undefined;
  items: RevisionListItem[];
  onClose: () => void;
  onRestored: (revision: RevisionView) => Promise<void>;
}) {
  const [selected, setSelected] = useState<RevisionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inspect = async (item: RevisionListItem) => {
    try {
      setSelected(await getRevision(input.renditionId, item.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取历史修订失败");
    }
  };
  const restore = async () => {
    if (selected === null || input.csrfToken === undefined) return;
    setBusy(true);
    try {
      const revision = await restoreRevision({
        renditionId: input.renditionId,
        csrfToken: input.csrfToken,
        historicalRevisionId: selected.id,
        expectedRevisionId: input.currentRevisionId,
      });
      await input.onRestored(revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="历史修订" subtitle="恢复会创建新修订，不会删除历史，也不会把当前指针移回旧版本。" onClose={input.onClose} wide>
      <div className="history-grid">
        <div className="history-list">
          {input.items.map((item) => (
            <button type="button" className={selected?.id === item.id ? "active" : ""} onClick={() => void inspect(item)} key={item.id}>
              <b>{item.reason}</b>
              <span>{new Date(item.createdAt).toLocaleString("zh-CN")}</span>
              <small>{item.createdBy} · {item.evidenceState === "unresolved" ? "历史引用未解析" : item.evidenceState}</small>
            </button>
          ))}
        </div>
        <div className="history-preview">
          {selected === null ? <p>选择一条修订查看结构。</p> : (
            <>
              <div className="panel-title-row">
                <div><span className="eyebrow">修订 {selected.id.slice(0, 8)}</span><h3>{selected.ast.title}</h3></div>
                <span className="soft-pill">{selected.templateVersionId === null ? "无模板" : "固定模板"}</span>
              </div>
              <RevisionOutline ast={selected.ast} />
              <button className="button primary" type="button" disabled={busy} onClick={() => void restore()}>
                {busy ? "正在恢复…" : "恢复为当前新修订"}
              </button>
            </>
          )}
          {error === null ? null : <ErrorLine message={error} />}
        </div>
      </div>
    </Dialog>
  );
}

function RevisionOutline({ ast }: { ast: Ast }) {
  const containers = ast.kind === "feishu_doc" ? ast.sections : ast.slides;
  return (
    <div className="revision-outline">
      {containers.map((container) => (
        <div key={container.id}>
          <b>{container.title}</b>
          <small>{container.blocks.length} 个块</small>
        </div>
      ))}
    </div>
  );
}

function DeriveDialog(input: {
  content: ContentDetail;
  rendition: ContentDetail["renditions"][number];
  fromRevisionId: string;
  csrfToken: string | undefined;
  confirmationId: string | null;
  onClose: () => void;
  onDone: (result: import("@dmall/contracts").DeriveRenditionResult) => void;
}) {
  const [kind, setKind] = useState<ContentKind>(input.rendition.kind === "feishu_doc" ? "html_deck" : "feishu_doc");
  const [label, setLabel] = useState("派生版本");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="派生另一格式" subtitle="新分支有自己的当前指针和初始空稿；源 Brief 与源分支保持独立。" onClose={input.onClose}>
      <label className="field"><span>目标格式</span>
        <select value={kind} onChange={(event) => setKind(event.target.value as ContentKind)}>
          <option value="feishu_doc">飞书文档</option>
          <option value="html_deck">HTML 演示</option>
        </select>
      </label>
      <label className="field"><span>分支名称</span><input value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <div className="dialog-actions">
        <button className="button secondary" type="button" onClick={input.onClose}>取消</button>
        <button className="button primary" type="button" disabled={busy || input.csrfToken === undefined} onClick={() => {
          if (input.csrfToken === undefined) return;
          setBusy(true);
          void deriveRendition({
            contentId: input.content.id,
            csrfToken: input.csrfToken,
            fromRevisionId: input.fromRevisionId,
            targetKind: kind,
            label,
            confirmationId: input.confirmationId,
          }).then(input.onDone).catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : "派生失败");
          }).finally(() => setBusy(false));
        }}>{busy ? "正在派生…" : "建立派生分支"}</button>
      </div>
      {error === null ? null : <ErrorLine message={error} />}
    </Dialog>
  );
}

function blockTypeLabel(type: Block["type"]): string {
  return ({
    heading: "小标题",
    paragraph: "正文",
    list: "列表",
    image: "图片",
    video: "视频",
    table: "表格",
    callout: "提示",
    divider: "分隔线",
    readonly_source_block: "来源只读",
  } as Record<Block["type"], string>)[type];
}

function kindLabel(kind: ContentKind): string {
  return kind === "feishu_doc" ? "飞书文档" : "HTML 演示";
}

async function loadPreview(candidateId: string): Promise<MergePreview> {
  const response = await fetch(`/api/v1/candidates/${candidateId}/preview`, { credentials: "same-origin" });
  const raw = await response.json() as { data?: MergePreview; error?: { message?: string } };
  if (!response.ok || raw.data === undefined) throw new Error(raw.error?.message ?? "读取候选预览失败");
  return raw.data;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取录音文件失败"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}
