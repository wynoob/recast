import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobState } from "@dmall/contracts";
import { ApiClientError } from "../../api.js";
import {
  cancelJob,
  isTerminalJobState,
  jobQuery,
  scanDetailQuery,
} from "./api.js";
import {
  jobStateLabel,
  jobStateTone,
  mappingResultText,
  mappingStatusLabel,
  phaseLabel,
} from "./format.js";
import { removeTask, useTaskRecords, type TaskRecord } from "./task-store.js";
import { cancelScanIntent, useScanIntents } from "./scan-intents.js";
import { useImportMonitor } from "./use-import-monitor.js";
import { useJobEvents } from "./use-job-events.js";
import { Dialog, ErrorLine, LoadingLine } from "../../ui.js";

export function TasksDrawer({
  csrfToken,
  onClose,
}: {
  csrfToken: string | undefined;
  onClose: () => void;
}) {
  const records = useTaskRecords();
  const intents = useScanIntents();
  return (
    <Dialog
      title="任务"
      subtitle="状态来自本机服务。关闭页面或抽屉不会伪造完成，重新打开会先核对真实任务。"
      onClose={onClose}
      wide
    >
      {intents.map((intent) => <PendingScanCard key={intent.key} intent={intent} csrfToken={csrfToken} />)}
      {records.length === 0 && intents.length === 0 ? (
        <div className="empty-panel compact">
          <span className="empty-icon" aria-hidden="true">◷</span>
          <h2>还没有任务记录</h2>
          <p>从素材库发起的扫描和导入会出现在这里。记录只保存任务编号，结果始终从服务端读取。</p>
        </div>
      ) : (
        <div className="task-list">
          {records.map((record) => (
            <TaskCard key={record.jobId} record={record} csrfToken={csrfToken} onClose={onClose} />
          ))}
        </div>
      )}
      <div className="dialog-actions">
        <button className="button" type="button" onClick={onClose}>关闭</button>
      </div>
    </Dialog>
  );
}

function PendingScanCard({ intent, csrfToken }: {
  intent: ReturnType<typeof useScanIntents>[number];
  csrfToken: string | undefined;
}) {
  const [pending, setPending] = useState(false);
  const reconcile = async () => {
    if (csrfToken === undefined || pending) return;
    setPending(true);
    try { await cancelScanIntent(intent.key, csrfToken); }
    catch { }
    finally { setPending(false); }
  };
  return (
    <article className="task-card">
      <div className="task-top"><h3>{intent.label}</h3><span className="state-pill draft">{intent.kind === "creating" ? "扫描结果待核对" : "取消待确认"}</span></div>
      <p className="section-note">关闭不会把未知结果显示为已取消。核对后会停止这次扫描。</p>
      {intent.message === null ? null : <ErrorLine message={intent.message} />}
      <div className="dialog-actions"><button className="button small" type="button" disabled={csrfToken === undefined || pending} onClick={() => { void reconcile(); }}>{pending ? "正在核对…" : "核对并取消"}</button></div>
    </article>
  );
}

function TaskCard({
  record,
  csrfToken,
  onClose,
}: {
  record: TaskRecord;
  csrfToken: string | undefined;
  onClose: () => void;
}) {
  return record.kind === "import"
    ? <ImportTaskCard record={record} csrfToken={csrfToken} onClose={onClose} />
    : <ScanTaskCard record={record} csrfToken={csrfToken} onClose={onClose} />;
}

function ImportTaskCard({ record, csrfToken, onClose }: {
  record: TaskRecord;
  csrfToken: string | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const monitor = useImportMonitor({ importId: record.importId ?? record.jobId, jobId: record.jobId, csrfToken });
  const { job, detail, stream, terminal, pendingAction, actionError } = monitor;
  const missing = job.error instanceof ApiClientError && job.error.status === 404;
  if (missing) return <MissingTask record={record} />;
  const data = detail.data;
  return (
    <article className="task-card">
      <div className="task-top">
        <div><span className="eyebrow">导入</span><h3>{record.label}</h3></div>
        <span className={`state-pill ${toneClass(data?.status)}`}>{data === undefined ? "核对中" : jobStateLabel(data.status)}</span>
      </div>
      {detail.isLoading ? <LoadingLine label="正在核对任务状态" /> : null}
      {detail.isError ? <ErrorLine message={detail.error.message} /> : null}
      {job.isError ? <ErrorLine message={job.error.message} /> : null}
      {data === undefined ? null : (
        <>
          <div className="task-meta">
            <span>{phaseLabel(data.phase)} · 尝试 {job.data?.attempt ?? "—"} / {job.data?.maxAttempts ?? "—"}</span>
            <span>{stream === "live" ? "实时更新" : stream === "polling" ? "2 秒轮询" : "连接中"}</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentOf(data.counts.committed + data.counts.failed + data.counts.skipped, data.counts.total)}>
            <i style={{ width: `${percentOf(data.counts.committed + data.counts.failed + data.counts.skipped, data.counts.total)}%` }} />
          </div>
          <div className="task-meta"><span>{data.counts.committed} / {data.counts.total} 项已完成</span><span>{data.counts.failed} 项失败</span></div>
          {data.mapping === null ? null : (
            <div className="task-mapping">
              <span className={`state-pill ${data.mapping.status === "applied" ? "ready" : data.mapping.status === "pending" || data.mapping.status === "partial" ? "draft" : "archived"}`}>
                {mappingStatusLabel(data.mapping.status)}
              </span>
              <span>{mappingResultText(data.mapping)}</span>
            </div>
          )}
          {data.error === null ? null : <ErrorLine message={data.error.message} />}
        </>
      )}
      {actionError === null ? null : <ErrorLine message={actionError} />}
      <div className="dialog-actions wrap">
        <button className="button small" type="button" onClick={() => { onClose(); navigate(`/assets?import=${record.importId ?? record.jobId}`); }}>查看完整队列</button>
        {!terminal && data !== undefined ? <button className="button small danger" type="button" onClick={() => { void monitor.cancel(); }} disabled={csrfToken === undefined || pendingAction !== null}>{pendingAction === "cancel" ? "正在取消…" : "取消任务"}</button> : null}
        {data?.status === "succeeded" || data?.status === "partial" ? <button className="button small primary" type="button" onClick={() => { onClose(); navigate("/assets"); }}>查看素材</button> : null}
        {terminal ? <button className="button small" type="button" onClick={() => removeTask(record.jobId)}>移除记录</button> : null}
      </div>
    </article>
  );
}

function ScanTaskCard({ record, csrfToken, onClose }: {
  record: TaskRecord;
  csrfToken: string | undefined;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const job = useQuery({
    ...jobQuery(record.jobId), retry: 0,
    refetchInterval: (query) => query.state.data !== undefined && isTerminalJobState(query.state.data.state) ? false : 2_000,
  });
  const scan = useQuery({
    ...scanDetailQuery(record.scanId ?? record.jobId), enabled: record.scanId !== null,
    refetchInterval: 2_000, retry: 0,
  });
  const stream = useJobEvents(record.jobId, () => {
    void queryClient.invalidateQueries({ queryKey: ["job", record.jobId] });
    if (record.scanId !== null) void queryClient.invalidateQueries({ queryKey: ["scan", record.scanId] });
  });
  const state = job.data?.state;
  const terminal = state !== undefined && isTerminalJobState(state);
  const cancel = async () => {
    if (csrfToken === undefined || pending) return;
    setPending(true);
    setActionError(null);
    try {
      await cancelJob({ jobId: record.jobId, csrfToken });
      await queryClient.invalidateQueries({ queryKey: ["job", record.jobId] });
      if (record.scanId !== null) await queryClient.invalidateQueries({ queryKey: ["scan", record.scanId] });
    } catch (reason) { setActionError(messageOf(reason)); }
    finally { setPending(false); }
  };
  if (job.error instanceof ApiClientError && job.error.status === 404) return <MissingTask record={record} />;
  return (
    <article className="task-card">
      <div className="task-top"><div><span className="eyebrow">扫描</span><h3>{record.label}</h3></div><span className={`state-pill ${toneClass(state)}`}>{job.isLoading ? "核对中" : state === undefined ? "状态未知" : jobStateLabel(state)}</span></div>
      {job.isLoading ? <LoadingLine label="正在核对任务状态" /> : null}
      {job.isError ? <ErrorLine message={job.error.message} /> : null}
      {scan.isError ? <ErrorLine message={scan.error.message} /> : null}
      {job.data === undefined ? null : <div className="task-meta"><span>{phaseLabel(job.data.phase)} · 尝试 {job.data.attempt} / {job.data.maxAttempts}</span><span>{stream === "live" ? "实时更新" : stream === "polling" ? "2 秒轮询" : "连接中"}</span></div>}
      {scan.data === undefined ? <div className="progress indeterminate"><i /></div> : <div className="task-meta"><span>候选 {scan.data.counts.candidate} · 排除 {scan.data.counts.excluded + scan.data.counts.unsupported + scan.data.counts.unreadable}</span><span>{scanStatusLabel(scan.data.status)}</span></div>}
      {job.data?.error === undefined || job.data.error === null ? null : <ErrorLine message={job.data.error.message} />}
      {actionError === null ? null : <ErrorLine message={actionError} />}
      <div className="dialog-actions wrap">
        {record.scanId === null ? null : <button className="button small" type="button" onClick={() => { onClose(); navigate(`/assets?scan=${record.scanId}`); }}>查看扫描</button>}
        {!terminal ? <button className="button small danger" type="button" onClick={() => { void cancel(); }} disabled={csrfToken === undefined || pending}>{pending ? "正在取消…" : "取消任务"}</button> : null}
        {terminal ? <button className="button small" type="button" onClick={() => removeTask(record.jobId)}>移除记录</button> : null}
      </div>
    </article>
  );
}

function MissingTask({ record }: { record: TaskRecord }) {
  return <article className="task-card"><div className="task-top"><h3>{record.label}</h3><span className="state-pill archived">记录已失效</span></div><p className="section-note">服务端已经找不到这个任务，不会保留虚构状态。</p><div className="dialog-actions"><button className="button small" type="button" onClick={() => removeTask(record.jobId)}>移除记录</button></div></article>;
}

function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

function scanStatusLabel(status: "queued" | "scanning" | "ready" | "consumed" | "expired" | "failed" | "cancelled"): string {
  if (status === "ready") return "可以确认导入";
  if (status === "consumed") return "已确认导入";
  if (status === "expired") return "扫描已过期";
  if (status === "failed") return "扫描失败";
  if (status === "cancelled") return "扫描已取消";
  return "扫描中";
}

function toneClass(state: JobState | undefined): string {
  if (state === undefined) return "archived";
  const tone = jobStateTone(state);
  if (tone === "good") return "ready";
  if (tone === "warn") return "draft";
  return "archived";
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作失败，请稍后重试";
}
