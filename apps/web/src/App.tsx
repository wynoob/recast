import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CapabilityState, ContentKind } from "@dmall/contracts";
import {
  assetsQuery,
  contentsQuery,
  createContent,
  healthQuery,
  settingsQuery,
  templatesQuery,
} from "./api.js";
import { Dialog, ErrorLine, Icon, LoadingLine, StatusRow } from "./ui.js";
import { useScanIntentRecovery } from "./features/assets/scan-intents.js";
import { TasksDrawer } from "./features/assets/TasksDrawer.js";
import { probeTextProvider, providersQuery, saveProviderConfig } from "./authoring/api.js";
import { jobQuery } from "./features/assets/api.js";

export function Shell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const health = useQuery(healthQuery);
  useScanIntentRecovery(health.data?.csrfToken);
  const contents = useQuery(contentsQuery);
  const assets = useQuery(assetsQuery);
  const templates = useQuery(templatesQuery);
  const [drawer, setDrawer] = useState<"settings" | "tasks" | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const create = async (input: { title: string; kind: ContentKind }) => {
    if (health.data === undefined) throw new Error("本地会话还在建立，请稍后重试");
    const detail = await createContent({ ...input, csrfToken: health.data.csrfToken });
    await queryClient.invalidateQueries({ queryKey: ["contents"] });
    setNewOpen(false);
    navigate(`/contents/${detail.id}`);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">D</span>
          <div>
            <div className="brand-name">Dmall 内容工作台</div>
            <div className="brand-sub">CONTENT TO DELIVERY</div>
          </div>
        </div>
        <nav className="topnav" aria-label="一级导航">
          <CapsuleLink to="/assets" label="素材库" count={assets.data?.total} />
          <CapsuleLink to="/templates" label="模板库" count={templates.data?.total} />
          <CapsuleLink to="/contents" label="内容库" count={contents.data?.total} />
        </nav>
        <div className="top-actions">
          <button className="icon-button" type="button" onClick={() => setDrawer("tasks")} aria-label="任务">
            <Icon name="history" />
          </button>
          <button className="icon-button" type="button" onClick={() => setDrawer("settings")} aria-label="设置">
            <Icon name="settings" />
          </button>
          <span className="local-chip"><span className="status-dot" />本机</span>
        </div>
      </header>
      <main className="main-content">
        <Outlet context={{ openNew: () => setNewOpen(true), openTasks: () => setDrawer("tasks"), health: health.data }} />
      </main>
      {drawer === "settings" ? <SettingsDrawer csrfToken={health.data?.csrfToken} onClose={() => setDrawer(null)} /> : null}
      {drawer === "tasks" ? <TasksDrawer csrfToken={health.data?.csrfToken} onClose={() => setDrawer(null)} /> : null}
      {newOpen ? (
        <NewContentDialog
          disabled={health.data === undefined}
          onClose={() => setNewOpen(false)}
          onCreate={create}
        />
      ) : null}
      <div className="ambient ambient-a" aria-hidden="true" />
      <div className="ambient ambient-b" aria-hidden="true" />
    </div>
  );
}

function CapsuleLink({ to, label, count }: { to: string; label: string; count: number | undefined }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `capsule-link${isActive ? " active" : ""}`}
    >
      <span>{label}</span>
      <span className="capsule-count">{count ?? 0}</span>
    </NavLink>
  );
}

export function NewContentDialog({
  disabled,
  onClose,
  onCreate,
}: {
  disabled: boolean;
  onClose: () => void;
  onCreate: (input: { title: string; kind: ContentKind }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ContentKind>("feishu_doc");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title="新建内容" subtitle="先建立空白稿。没有配置模型也可以保存标题和需求。" onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = title.trim();
          if (value === "" || disabled || busy) return;
          setBusy(true);
          setError(null);
          onCreate({ title: value, kind })
            .catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : "创建失败，请稍后重试");
            })
            .finally(() => setBusy(false));
        }}
      >
        <label className="field">
          <span>内容标题</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：本周进展汇报"
            maxLength={200}
            data-autofocus
          />
        </label>
        <fieldset className="format-field">
          <legend>先建立哪种格式</legend>
          <label className={`format-option${kind === "feishu_doc" ? " selected" : ""}`}>
            <input
              type="radio"
              name="kind"
              value="feishu_doc"
              checked={kind === "feishu_doc"}
              onChange={() => setKind("feishu_doc")}
            />
            <Icon name="doc" />
            <span><b>飞书文档</b><small>用于长文汇报与章节编辑</small></span>
          </label>
          <label className={`format-option${kind === "html_deck" ? " selected" : ""}`}>
            <input
              type="radio"
              name="kind"
              value="html_deck"
              checked={kind === "html_deck"}
              onChange={() => setKind("html_deck")}
            />
            <Icon name="slide" />
            <span><b>HTML 演示</b><small>用于分页演示与离线输出</small></span>
          </label>
        </fieldset>
        {error === null ? null : <div className="inline-error">{error}</div>}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose}>取消</button>
          <button className="button primary" type="submit" disabled={disabled || busy || title.trim() === ""}>
            {busy ? "正在保存…" : "建立空白内容"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function SettingsDrawer({ csrfToken, onClose }: { csrfToken: string | undefined; onClose: () => void }) {
  const settings = useQuery(settingsQuery);
  const providers = useQuery(providersQuery());
  const queryClient = useQueryClient();
  const [providerDrafts, setProviderDrafts] = useState<Record<string, { baseUrl: string; modelId: string; credentialEnv: string }>>({});
  const [providerError, setProviderError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [probeJobId, setProbeJobId] = useState<string | null>(null);
  const data = settings.data;
  const localImportEnabled = data !== undefined && data.features.localImport !== "not_implemented_t02";
  return (
    <Dialog title="设置与能力" subtitle="这里显示真实的本机状态。未配置的能力不会伪装为可用。" onClose={onClose} wide>
      {settings.isLoading ? <LoadingLine label="正在读取设置" /> : null}
      {settings.isError ? <ErrorLine message={settings.error.message} /> : null}
      {data === undefined ? null : (
        <>
          <section className="drawer-section">
            <h3>本机服务</h3>
            <StatusRow label="工作台服务" value="运行中" tone="good" />
            <StatusRow label="数据目录" value={data.storage.dataRoot} />
            <StatusRow label="后台任务" value={`${data.workers.poolSize} 个可用槽位`} />
          </section>
          <section className="drawer-section">
            <h3>模型能力</h3>
            <StatusRow label="文本生成" value={capabilityLabel(data.providers.text)} tone={capabilityTone(data.providers.text)} />
            <StatusRow label="中文向量" value={capabilityLabel(data.providers.embedding)} tone={capabilityTone(data.providers.embedding)} />
            <StatusRow label="视觉识别" value={capabilityLabel(data.providers.vision)} tone={capabilityTone(data.providers.vision)} />
            <StatusRow label="语音转写" value={capabilityLabel(data.providers.asr)} tone={capabilityTone(data.providers.asr)} />
            <StatusRow label="飞书" value={capabilityLabel(data.feishu)} tone={capabilityTone(data.feishu)} />
            <div className="provider-config-list">
              {(providers.data ?? []).map((provider) => {
                const draft = providerDrafts[provider.role] ?? {
                  baseUrl: provider.baseUrl ?? "",
                  modelId: provider.modelId ?? "",
                  credentialEnv: provider.keychainRef ?? "",
                };
                return (
                  <div className="provider-config-row" key={provider.role}>
                    <b>{roleLabel(provider.role)}</b>
                    <span className="soft-pill">{provider.configured ? (provider.verified ? "已验证" : "已填写，未验证") : "未配置"}</span>
                    <input
                      value={draft.baseUrl}
                      placeholder="API Base URL"
                      onChange={(event) => setProviderDrafts((current) => ({
                        ...current,
                        [provider.role]: { ...draft, baseUrl: event.target.value },
                      }))}
                    />
                    <input
                      value={draft.modelId}
                      placeholder="模型 ID"
                      onChange={(event) => setProviderDrafts((current) => ({
                        ...current,
                        [provider.role]: { ...draft, modelId: event.target.value },
                      }))}
                    />
                    <input
                      value={draft.credentialEnv}
                      placeholder="本机环境变量名（不保存密钥）"
                      onChange={(event) => setProviderDrafts((current) => ({
                        ...current,
                        [provider.role]: { ...draft, credentialEnv: event.target.value },
                      }))}
                    />
                    <button
                      className="mini-button"
                      type="button"
                      disabled={csrfToken === undefined || savingRole !== null || draft.baseUrl === "" || draft.modelId === "" || draft.credentialEnv === ""}
                      onClick={() => {
                        if (csrfToken === undefined) return;
                        setSavingRole(provider.role);
                        setProviderError(null);
                        void saveProviderConfig({
                          csrfToken,
                          request: {
                            schemaVersion: 1,
                            role: provider.role,
                            baseUrl: draft.baseUrl,
                            modelId: draft.modelId,
                            keychainRef: draft.credentialEnv,
                          },
                        }).then(async () => {
                          await queryClient.invalidateQueries({ queryKey: ["authoring", "providers"] });
                          await queryClient.invalidateQueries({ queryKey: ["settings"] });
                        }).catch((reason: unknown) => {
                          setProviderError(reason instanceof Error ? reason.message : "模型配置保存失败");
                        }).finally(() => setSavingRole(null));
                      }}
                    >
                      {savingRole === provider.role ? "保存中…" : "保存配置"}
                    </button>
                    {provider.role === "text" ? (
                      <button
                        className="mini-button"
                        type="button"
                        disabled={csrfToken === undefined || !provider.configured || probeJobId !== null}
                        onClick={() => {
                          if (csrfToken === undefined) return;
                          setProviderError(null);
                          void probeTextProvider({ csrfToken })
                            .then((job) => setProbeJobId(job.id))
                            .catch((reason: unknown) => setProviderError(reason instanceof Error ? reason.message : "模型探针创建失败"));
                        }}
                      >{probeJobId === null ? "验证文本模型" : "验证中…"}</button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {providerError === null ? null : <div className="inline-error">{providerError}</div>}
            {probeJobId === null ? null : (
              <ProviderProbeWatcher
                jobId={probeJobId}
                onDone={async () => {
                  setProbeJobId(null);
                  await queryClient.invalidateQueries({ queryKey: ["authoring", "providers"] });
                  await queryClient.invalidateQueries({ queryKey: ["settings"] });
                }}
              />
            )}
            <p className="panel-hint">凭证只写本机环境变量名，不写入数据库或日志。当前没有执行外部探针，所以新配置显示“未验证”，AI 生成按钮保持阻塞。</p>
          </section>
          <section className="drawer-section">
            <h3>当前可用动作</h3>
            <StatusRow
              label="扫描文件夹与导入本地副本"
              value={localImportEnabled ? "可用" : "当前版本不支持本地导入"}
              tone={localImportEnabled ? "good" : "muted"}
            />
            <StatusRow label="编辑素材标题与标签" value="可用" tone="good" />
            <StatusRow
              label="模板编辑与真实验证"
              value={data.features.templates === "not_implemented_t05" ? "未开放" : "可用"}
              tone={data.features.templates === "not_implemented_t05" ? "muted" : "good"}
            />
            <StatusRow label="完整编辑器" value={data.features.editor === "not_implemented_t06" ? "未开放" : "可用"} />
            <StatusRow label="飞书与 HTML 输出" value={data.features.outputs === "not_implemented_t07" ? "未开放" : "可用"} />
          </section>
        </>
      )}
      <div className="dialog-actions"><button className="button" type="button" onClick={onClose}>关闭</button></div>
    </Dialog>
  );
}

function roleLabel(role: "text" | "embedding" | "vision" | "asr"): string {
  return role === "text" ? "文本生成" : role === "embedding" ? "中文向量" : role === "vision" ? "视觉识别" : "语音转写";
}

function ProviderProbeWatcher(input: { jobId: string; onDone: () => Promise<void> }) {
  const job = useQuery({
    ...jobQuery(input.jobId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "succeeded" || state === "failed" || state === "waiting_input" || state === "cancelled" ? false : 1000;
    },
  });
  useEffect(() => {
    if (job.data?.state === "succeeded") void input.onDone();
    if (job.data?.state === "failed" || job.data?.state === "waiting_input") void input.onDone();
  }, [input, job.data?.state]);
  return (
    <div className="job-progress-card">
      <b>文本模型探针：{job.data?.state ?? "读取中"}</b>
      <p>{job.data?.error?.message ?? "探针只发送最小请求，不读取或保存凭证。"}</p>
    </div>
  );
}

function capabilityLabel(value: CapabilityState): string {
  switch (value.status) {
    case "configured": return "已配置并已验证";
    case "unverified": return "已填写，尚未验证";
    case "probe_failed": return "验证失败";
    case "unconfigured": return "未配置";
  }
}

function capabilityTone(value: CapabilityState): "good" | "warn" | "muted" {
  if (value.status === "configured") return "good";
  if (value.status === "unverified" || value.status === "probe_failed") return "warn";
  return "muted";
}

