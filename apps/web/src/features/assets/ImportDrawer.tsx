import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ImportDetail,
  ImportSelection,
  ScanDetail,
  ScanItemView,
} from "@dmall/contracts";
import {
  createImport,
  jobQuery,
  scanDetailQuery,
  scanItemsQuery,
  uploadFile,
  type UploadProgress,
} from "./api.js";
import {
  formatBytes,
  importItemStateLabel,
  mappingResultText,
  mappingSourceStatusLabel,
  mappingStatusLabel,
  phaseLabel,
  scanCountsSummary,
  scanExclusionLabel,
  scanKindLabel,
  jobStateLabel,
} from "./format.js";
import { cancelCreatedScan, cancelScanIntent, newScanIntent, runScanIntent } from "./scan-intents.js";
import { addTask } from "./task-store.js";
import { useImportMonitor } from "./use-import-monitor.js";
import { useJobEvents } from "./use-job-events.js";
import { Dialog, ErrorLine, Icon, LoadingLine } from "../../ui.js";

const CANDIDATE_PAGE_SIZE = 10;

interface MappingChoice {
  id: string;
  relativePath: string;
}

interface ChooseFlow {
  kind: "choose";
  mode: "directory" | "files";
  rootPath: string;
  files: File[];
  error: string | null;
}

interface UploadingFlow {
  kind: "uploading";
  files: File[];
  index: number;
  progress: UploadProgress | null;
}

interface UploadFailedFlow {
  kind: "upload_failed";
  files: File[];
  index: number;
  message: string;
}

interface StartingFlow {
  kind: "starting";
  label: string;
  fromUpload: boolean;
}

interface ScanFailedFlow {
  kind: "scan_failed";
  label: string;
  fromUpload: boolean;
  message: string;
}

interface ScanOperation {
  phase: "uploading" | "ready" | "creating";
  controller: AbortController;
  cancelled: boolean;
  intent: { key: string; label: string; fromUpload: boolean } | null;
}

interface ScanningFlow {
  kind: "scanning";
  scanId: string;
  jobId: string | null;
  label: string;
}

interface ConfirmFlow {
  kind: "confirm";
  scan: ScanDetail;
  scanJobId: string;
  label: string;
}

interface ImportingFlow {
  kind: "importing";
  importId: string;
  jobId: string;
  scanId: string;
  label: string;
}

type Flow =
  | ChooseFlow
  | UploadingFlow
  | UploadFailedFlow
  | StartingFlow
  | ScanFailedFlow
  | ScanningFlow
  | ConfirmFlow
  | ImportingFlow;

export function ImportDrawer({
  csrfToken,
  initialScanId,
  initialImportId,
  onClose,
  onOpenTasks,
  onFinished,
}: {
  csrfToken: string;
  initialScanId?: string;
  initialImportId?: string;
  onClose: () => void;
  onOpenTasks: () => void;
  onFinished: () => void;
}) {
  const hasInitial = initialImportId !== undefined || initialScanId !== undefined;
  const [flow, setFlow] = useState<Flow>(() => {
    if (initialImportId !== undefined) {
      return {
        kind: "importing",
        importId: initialImportId,
        jobId: initialImportId,
        scanId: "",
        label: "已恢复导入",
      };
    }
    if (initialScanId !== undefined) {
      return { kind: "scanning", scanId: initialScanId, jobId: null, label: "已恢复扫描" };
    }
    return { kind: "choose", mode: "directory", rootPath: "", files: [], error: null };
  });

  const operation = useRef<ScanOperation | null>(null);
  const mounted = useRef(true);
  const isCurrent = (op: ScanOperation) => mounted.current && operation.current === op && !op.cancelled;
  const cancelOperation = (op: ScanOperation) => {
    op.cancelled = true;
    op.controller.abort();
    if (op.intent !== null) void cancelScanIntent(op.intent.key, csrfToken).catch(() => undefined);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const op = operation.current;
      if (op !== null) {
        op.cancelled = true;
        op.controller.abort();
        if (op.intent !== null) void cancelScanIntent(op.intent.key, csrfToken).catch(() => undefined);
      }
    };
  }, [csrfToken]);

  const close = () => {
    if (operation.current !== null) cancelOperation(operation.current);
    onClose();
  };

  const create = async (op: ScanOperation) => {
    const intent = op.intent;
    if (intent === null || !isCurrent(op) || op.phase === "creating") return;
    op.phase = "creating";
    setFlow({ kind: "starting", label: intent.label, fromUpload: intent.fromUpload });
    try {
      const created = await runScanIntent(intent.key, csrfToken);
      if (created === null) return;
      if (!isCurrent(op)) {
        await cancelCreatedScan(intent.key, created, intent.label, csrfToken).catch(() => undefined);
        return;
      }
      addTask({ jobId: created.jobId, kind: "scan", scanId: created.scanId, importId: null, label: intent.label, createdAt: new Date().toISOString() });
      operation.current = null;
      setFlow({ kind: "scanning", scanId: created.scanId, jobId: created.jobId, label: intent.label });
    } catch (reason) {
      if (isCurrent(op)) {
        op.phase = "ready";
        setFlow({ kind: "scan_failed", label: intent.label, fromUpload: intent.fromUpload, message: messageOf(reason) });
      }
    }
  };

  const startDirectory = async () => {
    if (flow.kind !== "choose" || operation.current !== null) return;
    const rootPath = flow.rootPath.trim();
    if (!rootPath.startsWith("/")) {
      setFlow({ ...flow, error: "请输入本次要扫描的绝对目录路径。" });
      return;
    }
    const label = basename(rootPath);
    const key = newScanIntent({ schemaVersion: 1, sourceKind: "local_directory", rootPath, options: { generatePreviews: true } }, label);
    const op: ScanOperation = { phase: "ready", controller: new AbortController(), cancelled: false, intent: { key, label, fromUpload: false } };
    operation.current = op;
    await create(op);
  };

  const startUpload = async (files: File[]) => {
    if (operation.current !== null) return;
    const op: ScanOperation = { phase: "uploading", controller: new AbortController(), cancelled: false, intent: null };
    operation.current = op;
    setFlow({ kind: "uploading", files, index: 0, progress: null });
    let currentIndex = 0;
    try {
      const fileIds: string[] = [];
      for (let index = 0; index < files.length; index += 1) {
        if (!isCurrent(op)) return;
        currentIndex = index;
        const file = files[index];
        if (file === undefined) continue;
        setFlow({ kind: "uploading", files, index, progress: null });
        const result = await uploadFile({
          file,
          relativePath: file.webkitRelativePath === "" ? file.name : file.webkitRelativePath,
          csrfToken,
          signal: op.controller.signal,
          onProgress: (progress) => {
            if (isCurrent(op)) setFlow({ kind: "uploading", files, index, progress });
          },
        });
        if (!isCurrent(op)) return;
        fileIds.push(result.fileId);
      }
      if (!isCurrent(op)) return;
      const label = `本地上传（${files.length} 个文件）`;
      const key = newScanIntent({ schemaVersion: 1, sourceKind: "upload", fileIds, options: { generatePreviews: true } }, label);
      op.intent = { key, label, fromUpload: true };
      op.phase = "ready";
      await create(op);
    } catch (reason) {
      if (!isCurrent(op)) return;
      operation.current = null;
      setFlow({ kind: "upload_failed", files, index: currentIndex, message: messageOf(reason) });
    }
  };

  const title = hasInitial ? "查看导入" : "导入素材";
  const subtitle = hasInitial
    ? "任务状态来自本机服务。关闭抽屉不会停止任务。"
    : "先扫描，再确认复制。扫描不会改动所选目录。";

  return (
    <Dialog title={title} subtitle={subtitle} onClose={close} wide>
      <StepStrip active={flow.kind} />
      {flow.kind === "choose" ? (
        <ChooseStep
          flow={flow}
          onChange={setFlow}
          onCancel={close}
          onStartDirectory={() => { void startDirectory(); }}
          onStartUpload={(files) => { void startUpload(files); }}
        />
      ) : null}
      {flow.kind === "uploading" ? (
        <UploadProgressStep flow={flow} onCancel={close} />
      ) : null}
      {flow.kind === "upload_failed" ? (
        <section>
          <ErrorLine message={flow.message} />
          <div className="dialog-actions">
            <button className="button" type="button" onClick={() => setFlow({ kind: "choose", mode: "files", rootPath: "", files: flow.files, error: null })}>
              返回选择
            </button>
            <button className="button primary" type="button" onClick={() => { void startUpload(flow.files); }}>
              重新上传
            </button>
          </div>
        </section>
      ) : null}
      {flow.kind === "starting" ? (
        <section className="drawer-section">
          <h3>正在创建扫描</h3>
          <LoadingLine label="正在核对扫描任务" />
          <p className="section-note">{flow.label}</p>
          <div className="dialog-actions"><button className="button" type="button" onClick={close}>{flow.fromUpload ? "取消上传" : "取消扫描"}</button></div>
        </section>
      ) : null}
      {flow.kind === "scan_failed" ? (
        <section className="drawer-section">
          <ErrorLine message={flow.message} />
          <p className="section-note">尚未确认扫描结果。重试会核对同一次扫描；取消后可在任务入口核对取消结果。</p>
          <div className="dialog-actions">
            <button className="button" type="button" onClick={() => {
              const op = operation.current;
              if (op !== null) cancelOperation(op);
              operation.current = null;
              setFlow({ kind: "choose", mode: "directory", rootPath: "", files: [], error: null });
            }}>返回选择</button>
            <button className="button primary" type="button" onClick={() => { const op = operation.current; if (op !== null) void create(op); }}>重试扫描</button>
          </div>
        </section>
      ) : null}
      {flow.kind === "scanning" ? (
        <ScanningStep
          scanId={flow.scanId}
          jobId={flow.jobId}
          label={flow.label}
          onJob={(jobId) => setFlow({ ...flow, jobId })}
          onReady={(scan) => setFlow({ kind: "confirm", scan, scanJobId: scan.jobId, label: flow.label })}
          onBack={() => setFlow({ kind: "choose", mode: "directory", rootPath: "", files: [], error: null })}
          onClose={close}
        />
      ) : null}
      {flow.kind === "confirm" ? (
        <ConfirmStep
          scan={flow.scan}
          csrfToken={csrfToken}
          onBack={() => setFlow({ kind: "choose", mode: "directory", rootPath: "", files: [], error: null })}
          onImported={(created) => {
            addTask({
              jobId: created.jobId,
              kind: "import",
              scanId: flow.scan.scanId,
              importId: created.importId,
              label: flow.label,
              createdAt: new Date().toISOString(),
            });
            setFlow({
              kind: "importing",
              importId: created.importId,
              jobId: created.jobId,
              scanId: flow.scan.scanId,
              label: flow.label,
            });
          }}
        />
      ) : null}
      {flow.kind === "importing" ? (
        <ImportingStep
          importId={flow.importId}
          jobId={flow.jobId}
          scanId={flow.scanId}
          label={flow.label}
          csrfToken={csrfToken}
          onClose={close}
          onOpenTasks={onOpenTasks}
          onFinished={() => { onFinished(); onClose(); }}
          onRestart={() => setFlow({ kind: "choose", mode: "directory", rootPath: "", files: [], error: null })}
        />
      ) : null}
    </Dialog>
  );
}

function StepStrip({ active }: { active: Flow["kind"] }) {
  const index =
    active === "choose" ? 0
      : active === "uploading" || active === "upload_failed" || active === "starting" || active === "scan_failed" || active === "scanning" ? 1
        : active === "confirm" ? 2 : 3;
  const labels = ["选择", "扫描", "确认", "导入"];
  return (
    <div className="steps" aria-label="导入步骤">
      {labels.map((label, i) => (
        <div className={`step${i === index ? " on" : ""}${i < index ? " done" : ""}`} key={label}>
          {i + 1} · {label}
        </div>
      ))}
    </div>
  );
}

function ChooseStep({
  flow,
  onChange,
  onCancel,
  onStartDirectory,
  onStartUpload,
}: {
  flow: ChooseFlow;
  onChange: (flow: Flow) => void;
  onCancel: () => void;
  onStartDirectory: () => void;
  onStartUpload: (files: File[]) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const totalBytes = flow.files.reduce((sum, file) => sum + file.size, 0);
  return (
    <>
      <section className="drawer-section import-first">
        <h3>选择来源</h3>
        <div className="seg" role="tablist" aria-label="选择导入方式">
          <button
            type="button"
            className={flow.mode === "directory" ? "on" : ""}
            onClick={() => onChange({ ...flow, mode: "directory", error: null })}
          >
            文件夹路径
          </button>
          <button
            type="button"
            className={flow.mode === "files" ? "on" : ""}
            onClick={() => onChange({ ...flow, mode: "files", error: null })}
          >
            上传文件或目录
          </button>
        </div>
        {flow.mode === "directory" ? (
          <div className="choice-box">
            <label className="field">
              <span>本次要扫描的文件夹路径</span>
              <input
                value={flow.rootPath}
                onChange={(event) => onChange({ ...flow, rootPath: event.target.value, error: null })}
                placeholder="/Users/you/Documents/materials"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div className="readonly-note">
              <Icon name="lock" />
              <span>只读扫描。不会访问其他目录，不跟随指向目录外的链接。服务只读取目录项、文件信息与有限文件头。</span>
            </div>
          </div>
        ) : (
          <div className="choice-box">
            <div className="upload-pickers">
              <label className="button file-button">
                <Icon name="file" />
                选择文件
                <input
                  type="file"
                  multiple
                  accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.md,.markdown,.pdf,.pptx,.html,.htm,.zip"
                  data-testid="upload-files"
                  onChange={(event) => onChange({ ...flow, files: [...(event.target.files ?? [])], error: null })}
                />
              </label>
              <button className="button secondary" type="button" onClick={() => picker.current?.click()}>
                <Icon name="folder" />
                选择目录
              </button>
              <input
                ref={(node) => {
                  picker.current = node;
                  node?.setAttribute("webkitdirectory", "");
                  node?.setAttribute("directory", "");
                }}
                className="sr-only"
                type="file"
                multiple
                data-testid="upload-directory"
                onChange={(event) => onChange({ ...flow, files: [...(event.target.files ?? [])], error: null })}
              />
            </div>
            <div className="readonly-note">
              <Icon name="lock" />
              <span>文件按 8 MiB 分块上传。不会把大视频整段读入浏览器内存。</span>
            </div>
            {flow.files.length > 0 ? (
              <div className="picked-files">
                <strong>{flow.files.length} 个文件 · {formatBytes(totalBytes)}</strong>
                <span className="muted small">{flow.files.slice(0, 3).map((file) => file.name).join("、")}{flow.files.length > 3 ? "…" : ""}</span>
              </div>
            ) : null}
          </div>
        )}
        <p className="section-note">支持 PNG、JPEG、WebP、GIF、MP4、Markdown、PDF、PPTX、静态 HTML 与安全 HTML ZIP。缓存、构建产物、渲染目录和凭证文件会自动排除。</p>
        {flow.error === null ? null : <ErrorLine message={flow.error} />}
      </section>
      <Notice tone="info" title="扫描不是导入">
        扫描只列出候选、排除项和容量。你确认后才会复制文件。文字识别未配置，不影响本地文件与预览。
      </Notice>
      <div className="dialog-actions">
        <button className="button" type="button" onClick={onCancel}>取消</button>
        {flow.mode === "directory" ? (
          <button className="button primary" type="button" onClick={onStartDirectory} disabled={flow.rootPath.trim() === ""}>
            开始扫描
          </button>
        ) : (
          <button className="button primary" type="button" onClick={() => onStartUpload(flow.files)} disabled={flow.files.length === 0}>
            上传并扫描
          </button>
        )}
      </div>
    </>
  );
}

function UploadProgressStep({ flow, onCancel }: { flow: UploadingFlow; onCancel: () => void }) {
  const file = flow.files[flow.index];
  const percent = flow.progress === null ? 0 : Math.round((flow.progress.receivedBytes / Math.max(1, flow.progress.totalBytes)) * 100);
  return (
    <section className="drawer-section">
      <h3>正在上传</h3>
      <p className="section-note">{file?.name ?? "文件"} · 第 {flow.index + 1} / {flow.files.length} 个文件</p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-meta">
        <span>{flow.progress === null ? "准备文件块" : `第 ${flow.progress.chunkIndex} / ${flow.progress.chunkCount} 块`}</span>
        <span>{percent}%</span>
      </div>
      <Notice tone="info" title="关闭会停止上传">
        上传完成前还没有后台任务。关闭抽屉会取消本次上传，不会留下“已完成”的假状态。
      </Notice>
      <div className="dialog-actions">
        <button className="button" type="button" onClick={onCancel}>取消上传</button>
      </div>
    </section>
  );
}

function ScanningStep({
  scanId,
  jobId,
  label,
  onJob,
  onReady,
  onBack,
  onClose,
}: {
  scanId: string;
  jobId: string | null;
  label: string;
  onJob: (jobId: string) => void;
  onReady: (scan: ScanDetail) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const scan = useQuery({ ...scanDetailQuery(scanId), refetchInterval: 1_500 });
  const job = useQuery({
    ...jobQuery(jobId ?? scanId),
    enabled: jobId !== null,
    refetchInterval: 2_000,
  });
  useJobEvents(jobId, () => {
    void queryClient.invalidateQueries({ queryKey: ["scan", scanId] });
    if (jobId !== null) void queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  });

  useEffect(() => {
    if (scan.data !== undefined && jobId === null) onJob(scan.data.jobId);
  }, [jobId, onJob, scan.data]);

  useEffect(() => {
    if (scan.data?.status === "ready") onReady(scan.data);
  }, [onReady, scan.data]);

  const status = scan.data?.status;
  const failed = status === "failed" || status === "cancelled" || status === "expired";
  const counts = scan.data?.counts;
  return (
    <section className="drawer-section">
      <h3>正在核对文件</h3>
      <p className="section-note">{label}</p>
      {scan.isError ? <ErrorLine message={scan.error.message} /> : null}
      {failed ? (
        <ErrorLine message={status === "expired" ? "这次扫描已过期，请重新扫描。" : "扫描未完成，请查看任务状态后重试。"} />
      ) : null}
      <div className="progress indeterminate" role="progressbar" aria-label="正在扫描">
        <i />
      </div>
      <div className="progress-meta">
        <span>{scan.data === undefined ? "读取目录" : phaseLabel(job.data?.phase ?? "scanning")}</span>
        <span>总数未知，不显示假百分比</span>
      </div>
      <div className="status-grid">
        <div className="status-cell ok">
          <b>{counts?.candidate ?? "—"}</b>
          <span>候选文件</span>
        </div>
        <div className="status-cell warn">
          <b>{counts === undefined ? "—" : counts.excluded + counts.unsupported + counts.unreadable}</b>
          <span>排除或不支持</span>
        </div>
        <div className="status-cell">
          <b>{counts === undefined ? "—" : `${counts.mp4} / ${counts.gif} / ${counts.image}`}</b>
          <span>视频 / GIF / 图片</span>
        </div>
      </div>
      {counts === undefined ? null : (
        <p className="section-note">当前已发现 {scanCountsSummary(counts)}。计数会随扫描继续变化。</p>
      )}
      <Notice tone="info" title="没有复制文件">
        正在核对文件头、大小与目录边界。扫描完成前不会读取整个大视频，也不会写入所选目录。
      </Notice>
      <div className="dialog-actions">
        {failed || scan.isError ? <button className="button" type="button" onClick={onBack}>返回选择</button> : null}
        <button className="button" type="button" onClick={onClose}>收起</button>
      </div>
    </section>
  );
}

function ConfirmStep({
  scan,
  csrfToken,
  onBack,
  onImported,
}: {
  scan: ScanDetail;
  csrfToken: string;
  onBack: () => void;
  onImported: (created: { importId: string; jobId: string }) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [mode, setMode] = useState<"all" | "explicit">("all");
  const [included, setIncluded] = useState<Set<string>>(() => new Set());
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [mappingCursor, setMappingCursor] = useState<string | null>(null);
  const [mappingChoices, setMappingChoices] = useState<MappingChoice[]>([]);
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = useQuery({ ...scanItemsQuery(scan.scanId, { status: "candidate", limit: CANDIDATE_PAGE_SIZE, cursor }) });
  const mappingItems = useQuery({
    ...scanItemsQuery(scan.scanId, { status: "candidate", kind: "markdown", limit: CANDIDATE_PAGE_SIZE, cursor: mappingCursor }),
  });

  const selectedCount = mode === "all" ? Math.max(0, scan.counts.candidate - excluded.size) : included.size;
  const mediaCount = scan.counts.mp4 + scan.counts.gif + scan.counts.image;
  const documentCount =
    scan.counts.markdown + scan.counts.pdf + scan.counts.pptx + scan.counts.html + scan.counts.htmlZip;

  const resetConfirmation = () => setCopyConfirmed(false);
  const itemSelected = (id: string) => mode === "all" ? !excluded.has(id) : included.has(id);
  const removeMapping = (id: string) => {
    setMappingChoices((current) => current.filter((choice) => choice.id !== id));
  };

  const toggleItem = (item: ScanItemView) => {
    resetConfirmation();
    if (mode === "all") {
      const next = new Set(excluded);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
        removeMapping(item.id);
      }
      setExcluded(next);
      return;
    }
    const next = new Set(included);
    if (next.has(item.id)) {
      next.delete(item.id);
      removeMapping(item.id);
    } else {
      next.add(item.id);
    }
    setIncluded(next);
  };

  const selectAll = () => {
    resetConfirmation();
    setMode("all");
    setExcluded(new Set());
    setIncluded(new Set());
  };

  const clearAll = () => {
    resetConfirmation();
    setMode("explicit");
    setIncluded(new Set());
    setMappingChoices([]);
  };

  const toggleMapping = (item: ScanItemView) => {
    resetConfirmation();
    if (mappingChoices.some((choice) => choice.id === item.id)) {
      removeMapping(item.id);
      return;
    }
    if (mappingChoices.length >= 3) return;
    setMappingChoices((current) => [...current, { id: item.id, relativePath: item.relativePath }]);
  };

  const moveMapping = (index: number, direction: -1 | 1) => {
    setMappingChoices((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const item = next[index];
      const other = next[target];
      if (item === undefined || other === undefined) return current;
      next[index] = other;
      next[target] = item;
      return next;
    });
  };

  const submit = async () => {
    if (selectedCount === 0 || !copyConfirmed || pending) return;
    setPending(true);
    setError(null);
    const selection: ImportSelection =
      mode === "all"
        ? { mode: "all", includeItemIds: [], excludeItemIds: [...excluded] }
        : { mode: "explicit", includeItemIds: [...included], excludeItemIds: [] };
    try {
      const created = await createImport({
        scanId: scan.scanId,
        selection,
        ...(mappingChoices.length === 0
          ? {}
          : {
              assetMap: {
                format: "markdown-asset-table/v1" as const,
                sourceScanItemIds: mappingChoices.map((choice) => choice.id),
              },
            }),
        csrfToken,
      });
      onImported({ importId: created.importId, jobId: created.jobId });
    } catch (reason) {
      setError(messageOf(reason));
      setPending(false);
    }
  };

  const pageStart = cursor === null ? 1 : Number(cursor) + 1;
  const pageEnd = cursor === null
    ? (items.data?.items.length ?? 0)
    : Number(cursor) + (items.data?.items.length ?? 0);

  return (
    <>
      <section className="drawer-section">
        <h3>确认导入范围</h3>
        <div className="summary-grid">
          <div className="summary"><span>可导入</span><strong>{mediaCount} 媒体 + {documentCount} 文档</strong></div>
          <div className="summary"><span>文件类型</span><strong>{scan.counts.mp4} MP4 · {scan.counts.gif} GIF · {scan.counts.image} 图片 · {documentCount} 文档</strong></div>
          <div className="summary"><span>候选容量</span><strong>{formatBytes(scan.counts.totalBytes)}</strong></div>
          <div className="summary"><span>自动排除</span><strong>{scan.counts.excluded + scan.counts.unsupported + scan.counts.unreadable} 项</strong></div>
        </div>
        <p className="section-note">已选 {selectedCount} 项。清空选择不会自动变成全选。</p>
      </section>

      <section className="drawer-section">
        <div className="panel-title-row">
          <h3>候选文件</h3>
          <div className="seg compact">
            <button type="button" onClick={selectAll}>全选</button>
            <button type="button" onClick={clearAll}>清空</button>
          </div>
        </div>
        {items.isLoading ? <LoadingLine label="正在读取候选文件" /> : null}
        {items.isError ? <ErrorLine message={items.error.message} /> : null}
        {items.data !== undefined ? (
          <>
            <div className="candidate-list">
              {items.data.items.map((item) => {
                const checked = mode === "all" ? !excluded.has(item.id) : included.has(item.id);
                return (
                  <label className="candidate-row" key={item.id} data-testid={`candidate-${item.id}`} data-path={item.relativePath}>
                    <input type="checkbox" checked={checked} onChange={() => toggleItem(item)} />
                    <span className="candidate-kind" aria-hidden="true">
                      <Icon name={kindIcon(item.kind)} />
                    </span>
                    <span className="candidate-name">
                      <b>{item.relativePath}</b>
                      <small>{scanKindLabel(item.kind)} · {formatBytes(item.bytes)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="pager">
              <span className="muted small">第 {pageStart}–{pageEnd} 项，共 {items.data.total} 项</span>
              <div className="pager-actions">
                <button className="button small" type="button" disabled={cursor === null} onClick={() => setCursor(previousCursor(cursor))}>上一页</button>
                <button className="button small" type="button" disabled={items.data.nextCursor === null} onClick={() => setCursor(items.data.nextCursor)}>下一页</button>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <section className="drawer-section">
        <div className="panel-title-row">
          <h3>说明文档（可选）</h3>
          <span className="soft-pill">{mappingChoices.length} / 3</span>
        </div>
        <p className="section-note">只列出本次最终选择的 Markdown 文档。勾选最多三份，并按优先级排序。不会按文件名自动选择。</p>
        {mappingItems.isLoading ? <LoadingLine label="正在读取说明文档" /> : null}
        {mappingItems.isError ? <ErrorLine message={mappingItems.error.message} /> : null}
        {mappingItems.data === undefined ? null : (
          <>
            <div className="candidate-list">
              {mappingItems.data.items.filter((item) => itemSelected(item.id)).map((item) => {
                const checked = mappingChoices.some((choice) => choice.id === item.id);
                return (
                  <label className="candidate-row" key={item.id} data-testid={`mapping-choice-${item.id}`} data-path={item.relativePath}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && mappingChoices.length >= 3}
                      onChange={() => toggleMapping(item)}
                    />
                    <span className="candidate-kind" aria-hidden="true"><Icon name="doc" /></span>
                    <span className="candidate-name">
                      <b>{item.relativePath}</b>
                      <small>Markdown · {formatBytes(item.bytes)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            {mappingItems.data.items.filter((item) => itemSelected(item.id)).length === 0 ? (
              <p className="section-note">当前页没有已选说明文档，可翻页查看。</p>
            ) : null}
            <div className="pager">
              <span className="muted small">说明文档 · 共 {mappingItems.data.total} 份候选</span>
              <div className="pager-actions">
                <button
                  className="button small"
                  type="button"
                  disabled={mappingCursor === null}
                  onClick={() => setMappingCursor(previousCursor(mappingCursor))}
                >
                  上一页
                </button>
                <button
                  className="button small"
                  type="button"
                  disabled={mappingItems.data.nextCursor === null}
                  onClick={() => setMappingCursor(mappingItems.data.nextCursor)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
        {mappingChoices.length === 0 ? null : (
          <div className="mapping-order" aria-label="说明文档优先级">
            {mappingChoices.map((choice, index) => (
              <div className="mapping-order-row" key={choice.id} data-testid="mapping-selected" data-path={choice.relativePath}>
                <b>{index + 1}</b>
                <span>{choice.relativePath}</span>
                <div className="mapping-order-actions">
                  <button className="button small" type="button" aria-label={`上移 ${choice.relativePath}`} disabled={index === 0} onClick={() => moveMapping(index, -1)}>上移</button>
                  <button className="button small" type="button" aria-label={`下移 ${choice.relativePath}`} disabled={index === mappingChoices.length - 1} onClick={() => moveMapping(index, 1)}>下移</button>
                  <button className="button small" type="button" aria-label={`移除 ${choice.relativePath}`} onClick={() => removeMapping(choice.id)}>移除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {scan.exclusions.length > 0 || scan.counts.unsupported > 0 || scan.counts.unreadable > 0 ? (
        <section className="drawer-section">
          <h3>已排除或不支持</h3>
          <div className="exclude-list">
            {scan.exclusions.map((entry) => (
              <div className="exclude-row" key={entry.code}>
                <span>{scanExclusionLabel(entry.code)}<small>{entry.examples.slice(0, 2).join("、")}</small></span>
                <b>{entry.count}</b>
              </div>
            ))}
            {scan.counts.unsupported > 0 ? (
              <div className="exclude-row"><span>不在支持范围<small>不会显示为可用素材</small></span><b>{scan.counts.unsupported}</b></div>
            ) : null}
            {scan.counts.unreadable > 0 ? (
              <div className="exclude-row"><span>文件不可读<small>已单独记录</small></span><b>{scan.counts.unreadable}</b></div>
            ) : null}
          </div>
        </section>
      ) : null}

      <Notice tone="warn" title="文字识别未配置">
        当前只生成文件预览，不生成文字识别结果，也不会调用外部模型。缺图时保留位置和上下文。
      </Notice>

      <label className="confirm-copy">
        <input type="checkbox" checked={copyConfirmed} onChange={(event) => setCopyConfirmed(event.target.checked)} />
        <span>我确认把 {selectedCount} 个选中文件复制到工作台。原始目录保持只读。</span>
      </label>
      {error === null ? null : <ErrorLine message={error} />}
      <div className="dialog-actions">
        <button className="button" type="button" onClick={onBack} disabled={pending}>上一步</button>
        <button className="button primary" type="button" onClick={() => { void submit(); }} disabled={selectedCount === 0 || !copyConfirmed || pending}>
          {pending ? "正在创建任务…" : `确认导入 ${selectedCount} 项`}
        </button>
      </div>
    </>
  );
}

function ImportingStep({
  importId,
  jobId,
  scanId,
  label,
  csrfToken,
  onClose,
  onOpenTasks,
  onFinished,
  onRestart,
}: {
  importId: string;
  jobId: string;
  scanId: string;
  label: string;
  csrfToken: string;
  onClose: () => void;
  onOpenTasks: () => void;
  onFinished: () => void;
  onRestart: () => void;
}) {
  const monitor = useImportMonitor({ importId, jobId, csrfToken });
  const { detail, terminal, pendingAction, actionError } = monitor;

  useEffect(() => {
    if (detail.data === undefined) return;
    if (scanId === "" && detail.data.scanId !== "") {
      addTask({
        jobId,
        kind: "import",
        scanId: detail.data.scanId,
        importId,
        label,
        createdAt: new Date().toISOString(),
      });
    }
  }, [detail.data, importId, jobId, label, scanId]);

  if (detail.isLoading) return <LoadingLine label="正在读取导入任务" />;
  if (detail.isError) return <ErrorLine message={detail.error.message} />;
  if (detail.data === undefined) return null;
  const data = detail.data;
  const processed = data.counts.committed + data.counts.failed + data.counts.skipped;
  const percent = data.counts.total === 0 ? 0 : Math.round((processed / data.counts.total) * 100);
  const mapping = data.mapping;
  const mappingIssue = mapping !== null && (mapping.status === "partial" || mapping.status === "failed" || mapping.status === "skipped");
  const mappingReady = mapping === null || mapping.status === "applied";

  return (
    <>
      <section className="drawer-section">
        <div className="panel-title-row">
          <div>
            <h3>{label}</h3>
            <p className="section-note">{jobStateLabel(data.status)} · {phaseLabel(data.phase)}</p>
          </div>
          <span className={`state-pill ${toneClass(data.status)}`}>{jobStateLabel(data.status)}</span>
        </div>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <i style={{ width: `${percent}%` }} />
        </div>
        <div className="progress-meta">
          <span>{processed} / {data.counts.total} 项</span>
          <span>{percent}%</span>
        </div>
        <div className="status-grid">
          <div className="status-cell ok"><b>{data.counts.committed}</b><span>已完成</span></div>
          <div className="status-cell warn"><b>{data.counts.failed}</b><span>失败</span></div>
          <div className="status-cell"><b>{data.counts.pending}</b><span>等待</span></div>
        </div>
      </section>

      {mapping === null ? null : (
        <section className="drawer-section">
          <div className="panel-title-row">
            <h3>说明文档</h3>
            <span className={`state-pill ${mappingTone(mapping.status)}`}>{mappingStatusLabel(mapping.status)}</span>
          </div>
          <p className="section-note">{mappingResultText(mapping)}</p>
          <div className="mapping-result-list">
            {mapping.sources.map((source) => (
              <div className="mapping-result-row" key={source.sourceScanItemId} data-testid="mapping-result-source">
                <span><b>{source.relativePath}</b><small>{mappingSourceStatusLabel(source.status)} · {source.entryCount} 条映射</small></span>
                <span className="muted small">{source.linkedEntryCount} 个素材已关联{source.errorCode === null ? "" : ` · ${source.errorCode}`}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {mappingIssue ? (
        <Notice tone="warn" title={mapping?.status === "skipped" ? "说明文档未处理" : "说明文档未应用"}>
          {mapping === null ? "媒体已导入；说明文档未应用" : mappingResultText(mapping)}
        </Notice>
      ) : null}
      {mapping?.status === "pending" ? (
        <Notice tone="info" title="说明文档等待导入">等待说明文档导入</Notice>
      ) : null}

      {data.status === "partial" && !mappingIssue ? (
        <Notice tone="warn" title="部分完成">
          已完成的素材会保留；失败项不会显示为成功。可以只重试失败项，已提交项目不会重复复制原件。
        </Notice>
      ) : null}
      {data.status === "failed" ? (
        <Notice tone="error" title="导入未完成">{data.error?.message ?? "任务失败。已提交项目仍保留，可重试失败项。"}</Notice>
      ) : null}
      {data.status === "cancelled" ? (
        <Notice tone="warn" title="任务已取消">已完成的素材仍保留；未开始项没有复制。</Notice>
      ) : null}
      {data.status === "succeeded" && mappingReady ? (
        <Notice tone="success" title={`已导入 ${data.counts.committed} 项`}>
          原件、预览与来源均可查看。重复文件只保留一份原件，出现位置会分别保留。
        </Notice>
      ) : null}

      <section className="drawer-section">
        <h3>逐项进度</h3>
        <div className="queue">
          {data.items.map((item) => (
            <div className="queue-row" key={item.id}>
              <span className={`queue-state ${item.state}`} aria-hidden="true">
                {item.state === "committed" ? <Icon name="check" /> : item.state === "failed" ? <Icon name="alert" /> : <Icon name="file" />}
              </span>
              <span className="queue-name">
                <b>{item.relativePath}</b>
                {item.documentStatus === null || item.documentStatus === "complete"
                  ? null
                  : <small>{item.documentStatus === "partial" ? "正文或媒体部分完成，缺项见来源" : "抽取受阻，未伪装完整"}</small>}
                {item.errorMessage === null ? null : <small>{item.errorMessage}</small>}
              </span>
              <span className={`queue-label ${item.state}`}>{importItemStateLabel(item.state)}</span>
            </div>
          ))}
        </div>
        <div className="pager">
          <span className="muted small">第 {monitor.pageNumber} 页 · 本页 {data.items.length} 项 · 全部 {data.counts.total} 项</span>
          <div className="pager-actions">
            <button className="button small" type="button" disabled={!monitor.hasPrevious || pendingAction !== null} onClick={monitor.previous}>上一页</button>
            <button className="button small" type="button" disabled={data.nextCursor === null || pendingAction !== null} onClick={monitor.next}>下一页</button>
          </div>
        </div>
      </section>

      <Notice tone="warn" title="文字识别未配置">
        当前不生成文字识别结果。视频可播放，GIF 与图片使用原件或预览。
      </Notice>
      {actionError === null ? null : <ErrorLine message={actionError} />}
      {terminal ? null : (
        <Notice tone="info" title="关闭不等于取消">
          关闭抽屉或刷新页面不会停止任务。任务会继续在本机运行，状态保留在顶部任务入口。
        </Notice>
      )}

      <div className="dialog-actions wrap">
        {!terminal ? (
          <>
            <button className="button" type="button" onClick={onOpenTasks}>查看任务</button>
            <button className="button" type="button" onClick={onClose}>继续后台</button>
            <button className="button danger" type="button" onClick={() => { void monitor.cancel(); }} disabled={pendingAction !== null}>
              {pendingAction === "cancel" ? "正在取消…" : "取消任务"}
            </button>
          </>
        ) : (
          <>
            {monitor.canRetryPage ? (
              <button className="button" type="button" onClick={() => { void monitor.retryPage(); }} disabled={pendingAction !== null}>
                {pendingAction === "retry" ? "正在重试…" : `重试本页失败 ${monitor.pageFailed.length} 项`}
              </button>
            ) : null}
            <button className="button" type="button" onClick={onRestart}>再导入一次</button>
            {data.status === "succeeded" || data.status === "partial" ? (
              <button className="button primary" type="button" onClick={onFinished}>查看素材</button>
            ) : (
              <button className="button" type="button" onClick={onClose}>关闭</button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn" | "error" | "success";
  title: string;
  children: ReactNode;
}) {
  const icon = tone === "error" ? "alert" : tone === "success" ? "check" : tone === "warn" ? "alert" : "info";
  return (
    <div className={`notice ${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon name={icon} />
      <div><b>{title}</b><br />{children}</div>
    </div>
  );
}

function previousCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  const offset = Math.max(0, Number(cursor) - CANDIDATE_PAGE_SIZE);
  return offset === 0 ? null : String(offset);
}

function kindIcon(
  kind: "image" | "gif" | "video" | "markdown" | "pdf" | "pptx" | "html" | "html_zip" | "unsupported",
): "image" | "gif" | "video" | "doc" | "file" {
  if (kind === "markdown" || kind === "pdf" || kind === "pptx" || kind === "html" || kind === "html_zip") return "doc";
  if (kind === "video") return "video";
  if (kind === "gif") return "gif";
  if (kind === "image") return "image";
  return "file";
}

function toneClass(state: ImportDetail["status"]): string {
  if (state === "succeeded") return "ready";
  if (state === "partial" || state === "waiting_input") return "draft";
  return "archived";
}

function mappingTone(status: NonNullable<ImportDetail["mapping"]>["status"]): string {
  if (status === "applied") return "ready";
  if (status === "pending" || status === "partial") return "draft";
  return "archived";
}

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? "本地目录";
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作失败，请稍后重试";
}
