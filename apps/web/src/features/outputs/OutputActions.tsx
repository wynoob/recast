import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContentDetail, ProjectBundleImportRecord, PullRecord } from "@dmall/contracts";
import { Dialog, ErrorLine, Icon, LoadingLine } from "../../ui.js";
import {
  acceptPull,
  importProjectBundle,
  listExports,
  rejectPull,
  startFeishuPull,
  waitPull,
} from "./api.js";
import { ExportDialog } from "./ExportDialog.js";

type Rendition = ContentDetail["renditions"][number];

export interface OutputActionsProps {
  contentId: string;
  title: string;
  renditions: Rendition[];
  csrfToken: string;
  compact?: boolean;
  activeRenditionId?: string;
  prepareExport?: () => Promise<Rendition[]>;
}

export function OutputActions({
  contentId,
  title,
  renditions,
  csrfToken,
  compact = false,
  activeRenditionId,
  prepareExport,
}: OutputActionsProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogRenditions, setDialogRenditions] = useState(renditions);
  const [preparing, setPreparing] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [dialogRenditionId, setDialogRenditionId] = useState(renditions[0]?.id ?? "");
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ProjectBundleImportRecord | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [pull, setPull] = useState<PullRecord | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullBusy, setPullBusy] = useState(false);
  const [label, setLabel] = useState("飞书取回");
  const fileRef = useRef<HTMLInputElement>(null);

  const exports = useQuery({
    queryKey: ["exports", contentId],
    queryFn: () => listExports({ contentId }),
  });

  const importBundle = useMutation({
    mutationFn: async (file: File) => importProjectBundle({ file, csrfToken, title: `${title}（导入）` }),
    onSuccess: async (record) => {
      setImportResult(record);
      setImportError(null);
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      await queryClient.invalidateQueries({ queryKey: ["content", record.contentId] });
    },
    onError: (reason) => setImportError(reason instanceof Error ? reason.message : "项目包导入失败"),
  });

  const pullMutation = useMutation({
    mutationFn: async (record: { bindingId: string; revisionId: string }) => {
      setPullBusy(true);
      const started = await startFeishuPull({
        bindingId: record.bindingId,
        expectedLocalRevisionId: record.revisionId,
        csrfToken,
      });
      return waitPull(started.pullId);
    },
    onSuccess: (record) => {
      setPull(record);
      setPullError(null);
      setPullBusy(false);
    },
    onError: (reason) => {
      setPullBusy(false);
      setPullError(reason instanceof Error ? reason.message : "飞书取回失败");
    },
  });

  const accept = useMutation({
    mutationFn: async (record: PullRecord) => acceptPull({
      pullId: record.id,
      expectedLocalRevisionId: record.observedCurrentRevisionId,
      label: label.trim() || "飞书取回",
      csrfToken,
    }),
    onSuccess: async () => {
      setPull(null);
      await queryClient.invalidateQueries({ queryKey: ["content", contentId] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
    },
    onError: (reason) => setPullError(reason instanceof Error ? reason.message : "接受取回失败"),
  });

  const reject = useMutation({
    mutationFn: async (record: PullRecord) => rejectPull({ pullId: record.id, csrfToken }),
    onSuccess: () => {
      setPull(null);
      setPullError(null);
    },
    onError: (reason) => setPullError(reason instanceof Error ? reason.message : "取消取回失败"),
  });

  const latest = exports.data?.items[0];
  const bindable = exports.data?.items.find((item) => item.feishuBindingId !== null && item.remoteDocumentId !== null);

  return (
    <section className={`output-actions${compact ? " compact" : ""}`}>
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">输出与分发</span>
          <h2>把当前修订送到成品</h2>
        </div>
        <span className="soft-pill">真实任务</span>
      </div>
      <p className="output-actions-copy">
        导出先固定已保存修订。本地 HTML、PDF、项目包始终可用；飞书只在凭证和目标明确时开放。
      </p>
      <div className="output-action-grid">
        <button
          className="output-action-card"
          type="button"
          disabled={preparing}
          onClick={async () => {
            setPreparing(true);
            setExportError(null);
            try {
              const saved = prepareExport === undefined ? renditions : await prepareExport();
              setDialogRenditions(saved);
              setDialogRenditionId(activeRenditionId ?? saved[0]?.id ?? "");
              setDialogOpen(true);
            } catch (error) {
              setExportError(error instanceof Error ? error.message : "请先保存当前修改");
            } finally {
              setPreparing(false);
            }
          }}
        >
          <span className="output-action-icon"><Icon name="slide" /></span>
          <b>{preparing ? "正在保存稿件…" : "导出成品"}</b>
          <small>HTML ZIP、PDF、项目包或飞书文档</small>
        </button>
        <button className="output-action-card" type="button" onClick={() => setImportOpen(true)}>
          <span className="output-action-icon"><Icon name="upload" /></span>
          <b>导入项目包</b>
          <small>恢复为新的内容实体，不覆盖本机记录</small>
        </button>
        {bindable === undefined ? null : (
          <button
            className="output-action-card"
            type="button"
            disabled={pullBusy}
            onClick={() => pullMutation.mutate({
              bindingId: bindable.feishuBindingId ?? "",
              revisionId: bindable.revisionId,
            })}
          >
            <span className="output-action-icon"><Icon name="refresh" /></span>
            <b>{pullBusy ? "正在取回…" : "从飞书取回"}</b>
            <small>先预览差异，再决定是否创建具名新分支</small>
          </button>
        )}
      </div>
      {latest === undefined ? (
        <div className="output-empty-note">还没有导出记录。首次导出会写入本机历史。</div>
      ) : (
        <div className="output-latest">
          <div>
            <span className="eyebrow">最近一次</span>
            <b>{formatLabel(latest.format)}</b>
            <small>{formatDate(latest.createdAt)} · {statusLabel(latest.status)}</small>
          </div>
          {latest.artifacts[0] === undefined ? (
            <button className="button secondary small-button" type="button" onClick={() => setDialogOpen(true)}>
              查看输出
            </button>
          ) : (
            <a className="button secondary small-button" href={latest.artifacts[0].downloadUrl} download>
              下载
            </a>
          )}
        </div>
      )}
      {exports.data !== undefined && exports.data.items.length > 1 ? (
        <div className="output-history-list">
          {exports.data.items.slice(1, 5).map((item) => (
            <div key={item.id}>
              <span>{formatLabel(item.format)}</span>
              <small>{statusLabel(item.status)} · {formatDate(item.createdAt)}</small>
              {item.artifacts[0] === undefined ? null : (
                <a href={item.artifacts[0].downloadUrl} download>下载</a>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {pullError === null ? null : <ErrorLine message={pullError} />}

      {exportError === null ? null : <ErrorLine message={exportError} />}
      {dialogOpen && dialogRenditions.length > 0 ? (
        <ExportDialog
          contentId={contentId}
          renditions={dialogRenditions}
          initialRenditionId={dialogRenditionId}
          csrfToken={csrfToken}
          onClose={() => setDialogOpen(false)}
          onStarted={() => {
            void queryClient.invalidateQueries({ queryKey: ["exports", contentId] });
          }}
        />
      ) : null}

      {importOpen ? (
        <Dialog
          title="导入项目包"
          subtitle="项目包只在本机解析。导入会创建新的内容、稿件分支和修订，不改写既有内容。"
          onClose={() => setImportOpen(false)}
        >
          <div className="project-import-zone">
            <Icon name="folder" />
            <h3>选择 .zip 项目包</h3>
            <p>包内的会话、讲稿、来源引用和必要媒体会按 ID 映射恢复。无法解析的引用会阻止导入。</p>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) importBundle.mutate(file);
              }}
            />
            <button
              className="button primary"
              type="button"
              disabled={importBundle.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {importBundle.isPending ? "正在导入…" : "选择项目包"}
            </button>
          </div>
          {importBundle.isPending ? <LoadingLine label="校验并恢复项目包" /> : null}
          {importError === null ? null : <ErrorLine message={importError} />}
          {importResult === null ? null : (
            <div className="project-import-result">
              <h3>{importResult.status === "succeeded" ? "项目包已恢复" : "项目包导入未完成"}</h3>
              {importResult.contentId === null ? null : (
                <a className="button primary" href={`/contents/${importResult.contentId}`}>打开新内容</a>
              )}
              {importResult.report === null ? null : (
                <p>
                  修订 {importResult.report.imported.revisions ?? 0} 个，
                  素材版本 {importResult.report.imported.assetVersions ?? 0} 个，
                  消息 {importResult.report.imported.messages ?? 0} 条。
                </p>
              )}
            </div>
          )}
        </Dialog>
      ) : null}

      {pull === null ? null : (
        <Dialog
          title="飞书取回预览"
          subtitle="远端快照只生成预览，不会移动当前稿。接受后创建新的具名分支，原分支保留。"
          onClose={() => setPull(null)}
        >
          <div className="pull-summary">
            <div><span>差异计数</span><b>{pull.diffCount}</b></div>
            <div><span>共同基线</span><code>{pull.baseRevisionId}</code></div>
            <div><span>当前分支</span><code>{pull.observedCurrentRevisionId}</code></div>
            <div><span>远端状态</span><b>已生成取回快照</b></div>
          </div>
          <label className="field">
            <span>新分支名称</span>
            <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <div className="drawer-note">
            只读白板或未知块会保留为只读来源占位，再次输出时需要用户确认静态化或链接降级。
          </div>
          {pullError === null ? null : <ErrorLine message={pullError} />}
          <div className="dialog-actions">
            <button
              className="button secondary"
              type="button"
              disabled={reject.isPending}
              onClick={() => reject.mutate(pull)}
            >
              取消取回
            </button>
            <button
              className="button primary"
              type="button"
              disabled={accept.isPending || label.trim() === ""}
              onClick={() => accept.mutate(pull)}
            >
              {accept.isPending ? "创建分支中…" : "接受并创建新分支"}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function formatLabel(format: string): string {
  if (format === "html_zip") return "离线 HTML";
  if (format === "pdf") return "PDF";
  if (format === "project_bundle") return "项目包";
  return "飞书文档";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "生成中",
    waiting_input: "等待确认",
    succeeded: "已完成",
    partial: "部分完成",
    failed: "失败",
    blocked: "已阻断",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
