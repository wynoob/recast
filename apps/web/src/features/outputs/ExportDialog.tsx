import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ContentDetail,
  ExportFormat,
  ExportRecord,
  OutputPreview,
} from "@dmall/contracts";
import { Dialog, ErrorLine, Icon, LoadingLine } from "../../ui.js";
import {
  attachFeishuResult,
  createExport,
  getExport,
  listRevisions,
  previewOutput,
  retryExport,
} from "./api.js";

type Rendition = ContentDetail["renditions"][number];

const FORMATS: Array<{
  id: ExportFormat;
  title: string;
  copy: string;
  hint: string;
}> = [
  {
    id: "html_zip",
    title: "离线 HTML 包",
    copy: "index.html、assets、fonts 与 manifest 的相对路径成品。",
    hint: "断网可翻页、全屏、点击播放视频。",
  },
  {
    id: "pdf",
    title: "PDF",
    copy: "Chromium 受控打印，固定 16:9 与背景色。",
    hint: "GIF 和视频选择静帧，页面说明已静态化。",
  },
  {
    id: "project_bundle",
    title: "项目包",
    copy: "保留修订、模板、讲稿、会话、来源引用与必要媒体。",
    hint: "内部资料，用于回到工作台续改。",
  },
  {
    id: "feishu_doc",
    title: "生成新的飞书文档",
    copy: "按固定修订创建新的远端文档，保留块与媒体映射。",
    hint: "只有本机配置飞书用户凭证后才可执行。",
  },
];

export function ExportDialog({
  contentId,
  renditions,
  initialRenditionId,
  csrfToken,
  onClose,
  onStarted,
}: {
  contentId: string;
  renditions: Rendition[];
  initialRenditionId: string;
  csrfToken: string;
  onClose: () => void;
  onStarted?: (record: ExportRecord) => void;
}) {
  const queryClient = useQueryClient();
  const [renditionId, setRenditionId] = useState(initialRenditionId);
  const rendition = renditions.find((item) => item.id === renditionId) ?? renditions[0];
  const [revisionId, setRevisionId] = useState(rendition?.currentRevisionId ?? "");
  const [format, setFormat] = useState<ExportFormat>("html_zip");
  const [speakerNotes, setSpeakerNotes] = useState(false);
  const [feishuConfirmed, setFeishuConfirmed] = useState(false);
  const [folderToken, setFolderToken] = useState("");
  const [exportId, setExportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachId, setAttachId] = useState("");
  const [attachUrl, setAttachUrl] = useState("");

  useEffect(() => {
    if (rendition === undefined) return;
    setRevisionId(rendition.currentRevisionId);
  }, [rendition]);

  const revisions = useQuery({
    queryKey: ["revisions", renditionId],
    queryFn: () => listRevisions(renditionId),
    enabled: renditionId !== "",
  });
  const preview = useQuery({
    queryKey: ["output-preview", renditionId, revisionId],
    queryFn: () => previewOutput({ renditionId, revisionId }),
    enabled: renditionId !== "" && revisionId !== "",
  });
  const record = useQuery({
    queryKey: ["export", exportId],
    queryFn: () => getExport(exportId ?? ""),
    enabled: exportId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || ["queued", "running", "waiting_input"].includes(status) ? 1000 : false;
    },
  });

  useEffect(() => {
    if (record.data === undefined) return;
    if (["succeeded", "partial", "failed", "waiting_input", "cancelled"].includes(record.data.status)) {
      onStarted?.(record.data);
    }
  }, [record.data, onStarted]);

  const start = useMutation({
    mutationFn: async () => {
      if (rendition === undefined) throw new Error("缺少稿件分支");
      return createExport({
        csrfToken,
        renditionId: rendition.id,
        revisionId,
        format,
        speakerNotes,
        ...(folderToken.trim() === "" ? {} : { feishuFolderToken: folderToken.trim() }),
      });
    },
    onSuccess: async (result) => {
      setError(null);
      setExportId(result.exportId);
      await queryClient.invalidateQueries({ queryKey: ["exports", contentId] });
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "导出启动失败"),
  });

  const retry = useMutation({
    mutationFn: async () => {
      if (exportId === null) return;
      await retryExport({ exportId, csrfToken });
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "重试失败"),
  });

  const attach = useMutation({
    mutationFn: async () => {
      if (exportId === null) throw new Error("缺少导出任务");
      await attachFeishuResult({
        exportId,
        csrfToken,
        documentId: attachId.trim(),
        documentUrl: attachUrl.trim(),
      });
    },
    onSuccess: () => {
      setAttachOpen(false);
      void record.refetch();
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "绑定飞书结果失败"),
  });

  const activeRevision = revisions.data?.items.find((item) => item.id === revisionId);
  const selectedFormat = FORMATS.find((item) => item.id === format);
  const feishuAvailable = preview.data?.feishuConfigured === true;
  const blocked =
    format === "feishu_doc" &&
    (!feishuAvailable || !feishuConfirmed);

  return (
    <Dialog
      title="导出与分发"
      subtitle="先固定已保存修订，再选择输出格式。导出不会读取正在变化的草稿。"
      onClose={onClose}
      wide
      extraWide
    >
      <div className="output-workbench">
        <section className="output-column output-revision">
          <span className="eyebrow">01 固定版本</span>
          <h3>选择稿件分支与修订</h3>
          <div className="output-renditions">
            {renditions.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`output-rendition${item.id === renditionId ? " active" : ""}`}
                onClick={() => setRenditionId(item.id)}
              >
                <Icon name={item.kind === "feishu_doc" ? "doc" : "slide"} />
                <span><b>{item.label}</b><small>{item.kind === "feishu_doc" ? "飞书文档" : "HTML 演示"}</small></span>
              </button>
            ))}
          </div>
          {revisions.isLoading ? <LoadingLine label="读取修订历史" /> : null}
          <div className="output-revision-list">
            {revisions.data?.items.map((item) => (
              <label className={`output-revision-item${item.id === revisionId ? " selected" : ""}`} key={item.id}>
                <input
                  type="radio"
                  name="output-revision"
                  checked={item.id === revisionId}
                  onChange={() => setRevisionId(item.id)}
                />
                <span>
                  <b>{item.reason}</b>
                  <small>{formatDate(item.createdAt)} · {item.createdBy}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="output-fixed-note">
            <Icon name="lock" />
            <span>导出固定 revisionId：<code>{revisionId}</code></span>
          </div>
        </section>

        <section className="output-column output-format">
          <span className="eyebrow">02 选择输出</span>
          <h3>四种真实出口</h3>
          <div className="output-format-grid">
            {FORMATS.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`output-format-card${format === item.id ? " selected" : ""}`}
                onClick={() => setFormat(item.id)}
              >
                <span className="output-format-icon">
                  <Icon name={item.id === "html_zip" ? "slide" : item.id === "pdf" ? "file" : item.id === "project_bundle" ? "folder" : "doc"} />
                </span>
                <b>{item.title}</b>
                <small>{item.copy}</small>
                <em>{item.hint}</em>
              </button>
            ))}
          </div>
          <label className="output-toggle">
            <input
              type="checkbox"
              checked={speakerNotes}
              onChange={(event) => setSpeakerNotes(event.target.checked)}
            />
            <span>
              <b>包含讲稿</b>
              <small>默认不包含。开启后写入讲稿页或讲稿抽屉，不包含会话、上下文和令牌。</small>
            </span>
          </label>
        </section>

        <section className="output-column output-check">
          <span className="eyebrow">03 输出检查</span>
          <h3>{selectedFormat?.title}</h3>
          {preview.isLoading ? <LoadingLine label="检查资源引用" /> : null}
          {preview.isError ? <ErrorLine message={preview.error.message} /> : null}
          {preview.data === undefined ? null : <PreviewSummary preview={preview.data} />}
          {format === "feishu_doc" ? (
            <div className="output-feishu">
              <label className="field">
                <span>目标文件夹 token（可选）</span>
                <input
                  value={folderToken}
                  onChange={(event) => setFolderToken(event.target.value)}
                  placeholder="留空则创建到用户根目录"
                />
              </label>
              {!feishuAvailable ? (
                <div className="inline-error">飞书用户凭证未配置，此出口已阻断。HTML、PDF 和项目包仍可使用。</div>
              ) : (
                <label className="output-confirm">
                  <input
                    type="checkbox"
                    checked={feishuConfirmed}
                    onChange={(event) => setFeishuConfirmed(event.target.checked)}
                  />
                  <span>我确认要生成一个新的飞书文档</span>
                </label>
              )}
            </div>
          ) : null}
          {activeRevision === undefined ? null : (
            <div className="output-version-note">
              <span>这次会固定使用保存后的修订。</span>
              <b>{activeRevision.reason}</b>
            </div>
          )}
          {error === null ? null : <ErrorLine message={error} />}
          <button
            className="button primary output-start"
            type="button"
            disabled={start.isPending || rendition === undefined || revisionId === "" || blocked}
            onClick={() => start.mutate()}
          >
            {start.isPending ? "正在排队…" : format === "feishu_doc" ? "生成新的飞书文档" : "开始输出"}
          </button>
          {exportId === null ? null : (
            <ExportJobPanel
              record={record.data}
              loading={record.isLoading}
              error={record.error?.message ?? null}
              onRetry={() => retry.mutate()}
              onAttach={() => setAttachOpen(true)}
            />
          )}
        </section>
      </div>
      {attachOpen ? (
        <div className="output-attach-block">
          <span className="eyebrow">结果未知恢复</span>
          <h3>绑定已存在的飞书文档</h3>
          <p>先打开飞书核对文档确实已经创建，再填写 document_id 与 URL。系统不会自动重试创建。</p>
          <label className="field">
            <span>document_id</span>
            <input value={attachId} onChange={(event) => setAttachId(event.target.value)} />
          </label>
          <label className="field">
            <span>文档 URL</span>
            <input value={attachUrl} onChange={(event) => setAttachUrl(event.target.value)} />
          </label>
          <div className="dialog-actions">
            <button className="button secondary" type="button" onClick={() => setAttachOpen(false)}>取消</button>
            <button
              className="button primary"
              type="button"
              disabled={attach.isPending || attachId.trim() === "" || attachUrl.trim() === ""}
              onClick={() => attach.mutate()}
            >
              {attach.isPending ? "绑定中…" : "绑定并继续"}
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function PreviewSummary({ preview }: { preview: OutputPreview }) {
  return (
    <div className="output-preview-summary">
      <div className="output-preview-head">
        <span className="soft-pill">{preview.templateName}</span>
        <span className="soft-pill">{preview.rendererVersion}</span>
      </div>
      <div className="output-media-counts">
        <span><b>{preview.media.total}</b> 实际引用媒体</span>
        <span><b>{preview.media.images}</b> 图片</span>
        <span><b>{preview.media.gifs}</b> GIF</span>
        <span><b>{preview.media.videos}</b> 视频</span>
      </div>
      {preview.media.degraded.length > 0 ? (
        <div className="output-warning-list">
          <span className="eyebrow">降级摘要</span>
          {preview.media.degraded.slice(0, 4).map((item, index) => (
            <p key={`${item.nodeId}-${index}`}>{item.message}</p>
          ))}
        </div>
      ) : null}
      {preview.warnings.length > 0 ? (
        <div className="output-warning-list">
          {preview.warnings.map((warning, index) => (
            <p key={`${warning.code}-${index}`}>{warning.message}</p>
          ))}
        </div>
      ) : null}
      <div className="output-exclusions">
        默认排除：讲稿、隐藏块、会话、检索上下文、令牌、内部原始路径。
      </div>
    </div>
  );
}

function ExportJobPanel({
  record,
  loading,
  error,
  onRetry,
  onAttach,
}: {
  record: ExportRecord | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAttach: () => void;
}) {
  if (loading && record === undefined) return <LoadingLine label="读取输出任务" />;
  if (error !== null) return <ErrorLine message={error} />;
  if (record === undefined) return null;
  const statusLabel = {
    queued: "排队中",
    running: "生成中",
    waiting_input: "等待人工确认",
    succeeded: "已完成",
    partial: "部分完成",
    failed: "失败",
    blocked: "已阻断",
    cancelled: "已取消",
  }[record.status];
  return (
    <div className={`output-job-panel status-${record.status}`}>
      <div className="output-job-head">
        <span className="state-pill draft">{statusLabel}</span>
        <span className="muted small">固定修订 {record.revisionId.slice(0, 8)}</span>
      </div>
      {record.artifacts.length > 0 ? (
        <div className="output-artifacts">
          {record.artifacts.map((artifact) => (
            <a className="button secondary" href={artifact.downloadUrl} key={artifact.id} download>
              <Icon name="file" /> {artifact.fileName}
            </a>
          ))}
        </div>
      ) : null}
      {record.remoteUrl === null ? null : (
        <a className="button secondary" href={record.remoteUrl} target="_blank" rel="noreferrer">
          打开飞书文档
        </a>
      )}
      {record.error === null ? null : <ErrorLine message={`${record.error.message}${record.error.retryable ? "（可重试）" : ""}`} />}
      {record.warnings.length > 0 ? (
        <div className="output-warning-list">
          {record.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}
        </div>
      ) : null}
      {record.status === "failed" && record.error?.retryable === true ? (
        <button className="button secondary" type="button" onClick={onRetry}>重试任务</button>
      ) : null}
      {record.status === "waiting_input" && record.format === "feishu_doc" ? (
        <button className="button secondary" type="button" onClick={onAttach}>绑定已存在的飞书文档</button>
      ) : null}
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
